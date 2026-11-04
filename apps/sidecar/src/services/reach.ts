import {
  AppError,
  ErrorCode,
  REACH_SCHEMA_VERSION,
  ReachRequest,
  ReachSettings,
  type ReachRequestInput,
  type ReachResult,
  type ReachStatus,
} from "@agentdesk/shared";
import {
  createDefaultReachRegistry,
  ReachChannelError,
  type ReachContext,
  type ReachFetchInit,
  type ReachRegistry,
} from "@agentdesk/integrations";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import type { SecretStore } from "../secrets";
import { articleText } from "./insight-source";
import { fetchPublicSource, resolvePublicSource } from "./public-fetch";

export class ReachService {
  private readonly store: Collection<ReachSettings & { id: string }>;
  private readonly recent = new Map<string, ReachStatus["channels"][number]>();
  private readonly cooldown = new Map<string, number>();
  private readonly shutdown = new AbortController();

  constructor(
    db: Db,
    private readonly secrets: Pick<SecretStore, "get">,
    private readonly registry: ReachRegistry = createDefaultReachRegistry(),
  ) {
    this.store = new Collection(db, "settings");
  }

  getSettings(): ReachSettings {
    return ReachSettings.parse(this.store.get("reach") ?? { disabledChannels: [] });
  }

  updateSettings(input: ReachSettings): ReachSettings {
    const settings = ReachSettings.parse(input);
    if (settings.disabledChannels.some((id) => !this.registry.get(id))) {
      throw new AppError(ErrorCode.BadRequest, "包含未知的检索渠道");
    }
    this.store.put({ id: "reach", disabledChannels: [...new Set(settings.disabledChannels)] });
    return this.getSettings();
  }

  capabilities() {
    const disabled = new Set(this.getSettings().disabledChannels);
    return this.registry.capabilities((id) => !disabled.has(id));
  }

  status(): ReachStatus {
    return {
      channels: this.capabilities().channels.map(({ id, enabled }) => ({
        id,
        ok: null,
        lastCheckedAt: null,
        detail: null,
        ...this.recent.get(id),
        enabled,
      })),
    };
  }

  read(target: string, channel?: string, limit?: number, signal?: AbortSignal) {
    let selected = channel;
    if (!selected) {
      try {
        const host = new URL(target).hostname;
        selected = ["github.com", "www.github.com"].includes(host)
          ? "github"
          : ["v2ex.com", "www.v2ex.com"].includes(host)
            ? "v2ex"
            : "web";
      } catch {
        selected = "web";
      }
    }
    return this.run({ channel: selected, action: "read", target, limit }, signal);
  }

  async run(input: ReachRequestInput, signal?: AbortSignal): Promise<ReachResult> {
    const parsed = ReachRequest.safeParse(input);
    if (!parsed.success)
      throw new AppError(ErrorCode.BadRequest, "检索参数无效", parsed.error.issues);
    const request = parsed.data;
    const fail = (
      code: "NEED_SETUP" | "RATE_LIMITED",
      message: string,
      retryAfterSeconds?: number,
    ): ReachResult => ({
      schemaVersion: REACH_SCHEMA_VERSION,
      ok: false,
      channel: request.channel,
      action: request.action,
      backend: null,
      items: [],
      meta: {
        elapsedMs: 0,
        fetchedAt: new Date().toISOString(),
        attempts: [],
        truncated: false,
        sentTo: [],
      },
      error: {
        code,
        message,
        nextStep: code === "NEED_SETUP" ? "在设置 → 跨平台检索中启用该渠道" : "等待冷却结束后再试",
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    });
    if (this.getSettings().disabledChannels.includes(request.channel)) {
      return fail("NEED_SETUP", "该检索渠道已关闭");
    }
    const until = this.cooldown.get(request.channel) ?? 0;
    if (until > Date.now())
      return fail("RATE_LIMITED", "该渠道仍在限流冷却中", Math.ceil((until - Date.now()) / 1000));

    const deadline = Date.now() + 30_000;
    const combined = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    const sentTo = new Set<string>();
    const fetchContent = async (url: string, init: ReachFetchInit = {}) => {
      try {
        return await fetchPublicSource(url, {
          ...init,
          signal: combined,
          timeoutMs: Math.max(1, Math.min(init.timeoutMs ?? 15_000, deadline - Date.now())),
          maxBytes: Math.min(init.maxBytes ?? 4 * 1024 ** 2, 4 * 1024 ** 2),
          onRequest: (target) => sentTo.add(target.hostname),
        });
      } catch (error) {
        throw channelError(error, combined);
      }
    };
    const ctx: ReachContext = {
      signal: combined,
      deadline,
      sentTo,
      fetch: fetchContent,
      validateUrl: async (url) => {
        try {
          await resolvePublicSource(url, combined);
        } catch (error) {
          throw channelError(error, combined);
        }
      },
      secret: async (name) =>
        name === "github.token"
          ? (this.secrets.get("git:github:github.com") ?? undefined)
          : undefined,
      readArticle: async (url) => {
        const response = await fetchContent(url, {
          timeoutMs: 10_000,
          headers: { Accept: "text/html,text/plain" },
        });
        // 这些状态必须终止，不能借正文中转服务绕过限流或访问限制。
        if (response.status === 429)
          throw new ReachChannelError("RATE_LIMITED", "目标网站请求过于频繁", "稍后再试", 60);
        if (response.status === 401 || response.status === 403 || response.status === 451) {
          throw new ReachChannelError(
            "PLATFORM_BLOCKED",
            `目标网站拒绝访问（HTTP ${response.status}）`,
          );
        }
        if (response.status === 404) throw new ReachChannelError("NOT_FOUND", "目标网页不存在");
        if (response.status >= 400)
          throw new ReachChannelError("UPSTREAM_BROKEN", `网页 HTTP ${response.status}`);
        if (!/text\/(html|plain|markdown)|application\/xhtml/i.test(response.contentType)) {
          throw new ReachChannelError("BAD_INPUT", "链接未返回网页或文本内容");
        }
        const text = articleText(response.text, response.contentType);
        if (
          /环境异常|完成验证后即可继续访问|访问过于频繁|just a moment|attention required!|requiring captcha/i.test(
            text.slice(0, 1000),
          )
        ) {
          throw new ReachChannelError("PLATFORM_BLOCKED", "目标网站返回了访问验证页");
        }
        if (text.length < 100)
          throw new ReachChannelError("UPSTREAM_BROKEN", "本地未提取到足够正文");
        return text;
      },
    };
    const result = await this.registry.run(request.channel, request.action, request, ctx);
    if (result.error?.code === "RATE_LIMITED") {
      this.cooldown.set(
        request.channel,
        Date.now() + Math.max(1, result.error.retryAfterSeconds ?? 60) * 1000,
      );
    }
    if (this.registry.get(request.channel) && result.meta.attempts.length) {
      this.recent.set(request.channel, {
        id: request.channel,
        enabled: true,
        ok: result.ok,
        lastCheckedAt: result.meta.fetchedAt,
        detail: result.ok
          ? `最近调用成功 · ${result.backend}`
          : `${result.error?.code}：${result.error?.message}`,
      });
    }
    return result;
  }

  dispose() {
    this.shutdown.abort();
  }
}

function channelError(error: unknown, signal: AbortSignal): ReachChannelError {
  const cause = error instanceof Error ? error.cause : undefined;
  const networkTimeout =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    [
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ETIMEDOUT",
    ].includes(String(cause.code));
  if (
    signal.aborted ||
    networkTimeout ||
    (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
  ) {
    return new ReachChannelError("TIMEOUT", "已取消或请求超时");
  }
  if (error instanceof AppError && error.code === ErrorCode.BadRequest) {
    return new ReachChannelError("BAD_INPUT", error.message);
  }
  return new ReachChannelError(
    "UPSTREAM_BROKEN",
    "网络请求失败或响应超过大小限制",
    "检查网络后重试",
  );
}

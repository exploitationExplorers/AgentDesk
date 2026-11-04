import {
  REACH_SCHEMA_VERSION,
  ReachItem,
  TERMINAL_REACH_ERRORS,
  type ReachActionName,
  type ReachAttempt,
  type ReachCapabilities,
  type ReachErrorCode,
  type ReachResult,
} from "@agentdesk/shared";
import {
  ReachChannelError,
  type ReachBackend,
  type ReachChannelDef,
  type ReachContext,
  type ReachParams,
} from "./types";

/** 单条正文的长度上限，避免平台大对象整段进入对话记录。 */
const MAX_TEXT = 12_000;
/** 一次动作最多返回多少条。 */
const MAX_ITEMS = 25;

/**
 * 可插拔的渠道注册表。
 *
 * 新增渠道只需要实现 ReachChannelDef 再 register 一次——不管它底层是原生
 * TypeScript、外部 CLI 还是别的运行时，对上层都是同一套结果协议。
 */
export class ReachRegistry {
  private readonly channels = new Map<string, ReachChannelDef>();

  register(channel: ReachChannelDef): this {
    if (this.channels.has(channel.id))
      throw new Error(`Reach channel already registered: ${channel.id}`);
    this.channels.set(channel.id, channel);
    return this;
  }

  get(id: string): ReachChannelDef | undefined {
    return this.channels.get(id);
  }

  list(): ReachChannelDef[] {
    return [...this.channels.values()];
  }

  capabilities(isEnabled: (id: string) => boolean): ReachCapabilities {
    return {
      schemaVersion: REACH_SCHEMA_VERSION,
      channels: this.list().map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        actions: c.actions.map((a) => a.name),
        enabled: isEnabled(c.id),
        sendsDataTo: c.sendsDataTo,
        requires: c.requires,
      })),
    };
  }

  /**
   * 执行一次动作：按顺序尝试后端，可恢复的失败才换下一个。
   *
   * NEED_LOGIN / PLATFORM_BLOCKED / RATE_LIMITED / BAD_INPUT / NOT_FOUND 是终止态，
   * 立刻返回——继续换后端只会把同一个限流打得更死，或者在没有权限的地方反复撞墙。
   */
  async run(
    channelId: string,
    action: ReachActionName,
    params: ReachParams,
    ctx: ReachContext,
  ): Promise<ReachResult> {
    const startedAt = Date.now();
    const attempts: ReachAttempt[] = [];
    const channel = this.channels.get(channelId);

    const fail = (
      code: ReachErrorCode,
      message: string,
      nextStep: string | null,
      error?: ReachChannelError,
    ): ReachResult => ({
      schemaVersion: REACH_SCHEMA_VERSION,
      ok: false,
      channel: channelId,
      action,
      backend: null,
      items: clipItems(error?.items ?? []).items,
      meta: {
        elapsedMs: Date.now() - startedAt,
        fetchedAt: new Date().toISOString(),
        attempts,
        truncated: clipItems(error?.items ?? []).truncated,
        sentTo: [...ctx.sentTo],
      },
      error: {
        code,
        message: message.slice(0, 1000),
        nextStep,
        ...(error?.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    });

    if (!channel)
      return fail("BAD_INPUT", `没有这个渠道：${channelId}`, "用 reach.capabilities 查看可用渠道");
    const def = channel.actions.find((a) => a.name === action);
    if (!def)
      return fail(
        "BAD_INPUT",
        `渠道 ${channelId} 不支持动作 ${action}`,
        `它支持：${channel.actions.map((a) => a.name).join("、")}`,
      );

    let lastError: ReachChannelError | null = null;

    for (const backend of def.backends) {
      if (ctx.signal?.aborted) return fail("TIMEOUT", "已取消", null);
      if (Date.now() >= ctx.deadline) {
        attempts.push({ backend: backend.id, ok: false, code: "TIMEOUT", elapsedMs: 0 });
        return fail("TIMEOUT", "超出本次检索的时间预算", "缩小范围或稍后重试");
      }

      const t0 = Date.now();
      try {
        const raw = await runBackend(backend, params, ctx);
        if (ctx.signal?.aborted || Date.now() >= ctx.deadline) {
          throw new ReachChannelError("TIMEOUT", "已取消或超出检索时间预算");
        }
        const { items, truncated } = clipItems(ReachItem.array().parse(raw), params.limit);
        attempts.push({ backend: backend.id, ok: true, code: null, elapsedMs: Date.now() - t0 });

        return {
          schemaVersion: REACH_SCHEMA_VERSION,
          ok: true,
          channel: channelId,
          action,
          backend: backend.id,
          items,
          meta: {
            elapsedMs: Date.now() - startedAt,
            fetchedAt: new Date().toISOString(),
            attempts,
            truncated,
            sentTo: [...ctx.sentTo],
          },
          error: null,
        };
      } catch (error) {
        const err =
          ctx.signal?.aborted || Date.now() >= ctx.deadline
            ? new ReachChannelError("TIMEOUT", "已取消或超出检索时间预算")
            : error instanceof ReachChannelError
              ? error
              : new ReachChannelError(
                  "UPSTREAM_BROKEN",
                  error instanceof Error ? error.message : String(error),
                );
        attempts.push({
          backend: backend.id,
          ok: false,
          code: err.code,
          elapsedMs: Date.now() - t0,
        });
        lastError = err;
        if (TERMINAL_REACH_ERRORS.includes(err.code)) break;
      }
    }

    return fail(
      lastError?.code ?? "UPSTREAM_BROKEN",
      lastError?.message ?? "所有后端都没有返回结果",
      lastError?.nextStep ?? null,
      lastError ?? undefined,
    );
  }
}

async function runBackend(backend: ReachBackend, params: ReachParams, ctx: ReachContext) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, ctx.deadline - Date.now()));
  const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ReachChannelError("TIMEOUT", "已取消或超出检索时间预算"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
      backend.run(params, { ...ctx, signal }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function clipItems(raw: ReachItem[], limit = MAX_ITEMS) {
  let truncated = raw.length > limit;
  let remaining = 48_000;
  const items = raw.slice(0, Math.min(limit, MAX_ITEMS)).map((item) => {
    const clip = (value: string, max: number) => {
      if (value.length > max) truncated = true;
      return value.slice(0, max);
    };
    const text = clip(item.text, Math.min(MAX_TEXT, remaining));
    remaining -= text.length;
    const entries = Object.entries(item.extra ?? {});
    if (entries.length > 20 || item.extra?.commentsTruncated || item.extra?.repliesTruncated)
      truncated = true;
    return {
      ...item,
      title: clip(item.title, 512),
      url: clip(item.url, 4096),
      author: item.author === null ? null : clip(item.author, 256),
      publishedAt: item.publishedAt === null ? null : clip(item.publishedAt, 128),
      text,
      partial: item.partial || text.length < item.text.length,
      ...(item.extra
        ? {
            extra: Object.fromEntries(
              entries
                .slice(0, 20)
                .map(([key, value]) => [
                  clip(key, 80),
                  typeof value === "string" ? clip(value, 512) : value,
                ]),
            ),
          }
        : {}),
    };
  });
  return { items, truncated };
}

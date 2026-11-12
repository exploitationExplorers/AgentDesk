import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteCapability,
  type ProjectGrant,
  type RemoteActor,
  type RemoteCommand,
  type RemoteScope,
} from "@agentdesk/shared";
import type { GatewayConfig } from "../config";
export function commandDigest(value: unknown): string {
  const canonical = (item: z.infer<ReturnType<typeof z.json>>): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key]!)}`)
      .join(",")}}`;
  };
  return createHash("sha256")
    .update(canonical(z.json().parse(value)))
    .digest("hex");
}
export class RunnerClient {
  constructor(
    private readonly config: Pick<GatewayConfig, "runnerUrl" | "remoteToken">,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  forHost(hostId: string): RunnerClient {
    if (hostId !== "cloud") throw new AppError(ErrorCode.NotFound, "执行宿主不存在或尚未配对");
    return this;
  }
  protected epoch(): number {
    return 1;
  }
  async request(
    path: string,
    body?: unknown,
    options: {
      method?: string;
      signal?: AbortSignal;
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid internal runner route");
    let response: Response;
    const opening = new AbortController();
    const openingTimer = options.stream ? setTimeout(() => opening.abort(), 15000) : undefined;
    try {
      response = await this.fetcher(`${this.config.runnerUrl}/remote-api/v1${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "x-agentdesk-remote-token": this.config.remoteToken,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        ...(options.stream
          ? {
              signal: options.signal
                ? AbortSignal.any([options.signal, opening.signal])
                : opening.signal,
            }
          : {
              signal: options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
                : AbortSignal.timeout(30000),
            }),
      });
    } catch {
      throw new AppError(ErrorCode.HostOffline, "执行宿主暂时无法连接，请查询原任务状态后重试");
    } finally {
      clearTimeout(openingTimer);
    }
    if (!response.ok) {
      let code: (typeof ErrorCode)[keyof typeof ErrorCode] = ErrorCode.ServiceUnavailable;
      try {
        const body = (await response.json()) as {
          error?: {
            code?: string;
          };
        };
        if (Object.values(ErrorCode).includes(body.error?.code as typeof code))
          code = body.error!.code as typeof code;
      } catch {
        /* 不转发上游原始错误，避免泄露内部路径或凭据。 */
      }
      throw new AppError(code, runnerMessage(code));
    }
    return response;
  }
  async json<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<T> {
    const response = await this.request(path, body, method ? { method } : {});
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 2 * 1024 * 1024)
      throw new AppError(ErrorCode.ServiceUnavailable, "宿主响应过大，请缩小查询范围");
    const reader = response.body?.getReader();
    if (!reader) throw new AppError(ErrorCode.ServiceUnavailable, "宿主响应为空");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024)
          throw new AppError(ErrorCode.ServiceUnavailable, "宿主响应过大，请缩小查询范围");
        parts.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  }
  command(
    scope: RemoteScope,
    actor: RemoteActor,
    action: RemoteCapability,
    payload: unknown,
    requestId: string = randomUUID(),
  ): RemoteCommand {
    const now = Date.now();
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      requestId,
      ...scope,
      actor,
      connectionEpoch: this.forHost(scope.hostId).epoch(),
      action,
      payloadHash: commandDigest(payload),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30000).toISOString(),
    };
  }
  async grant(scope: RemoteScope): Promise<void> {
    const grant: ProjectGrant = {
      ...scope,
      capabilities: RemoteCapability.options,
      connectionEpoch: this.forHost(scope.hostId).epoch(),
      expiresAt: new Date(Date.now() + 45000).toISOString(),
      revokedAt: null,
    };
    await this.json("/grants", grant, "PUT");
  }
  async execute<T = Record<string, unknown>>(
    scope: RemoteScope,
    actor: RemoteActor,
    action: RemoteCapability,
    payload: unknown,
    requestId?: string,
  ): Promise<T> {
    await this.grant(scope);
    return await this.json<T>("/commands", {
      command: this.command(scope, actor, action, payload, requestId),
      payload,
    });
  }
}
function runnerMessage(code: string): string {
  const messages: Record<string, string> = {
    STALE_PREVIEW: "预览已失效，请重新预览并确认",
    REPO_BUSY: "仓库正在执行其他操作，请稍后重试",
    UNAUTHORIZED: "此操作需要重新验证邮箱",
    FORBIDDEN: "当前操作未获授权或授权已过期",
    NOT_FOUND: "宿主上的资源不存在",
    IDEMPOTENCY_CONFLICT: "相同请求标识对应了不同内容",
    APPROVAL_EXPIRED: "审批已过期，请重新发起",
    APPROVAL_REQUIRED: "请先审核并确认此操作",
    CONFLICT: "资源状态已变化，请刷新后核对",
    BAD_REQUEST: "请求参数不符合宿主要求",
    STORAGE_FULL: "宿主空间低于预留值，请在存储管理中清理空间或调整策略",
  };
  return messages[code] ?? "宿主暂时无法完成操作，请查看任务状态";
}

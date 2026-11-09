import { AppError, ErrorCode, type RemoteActor, type RemoteScope } from "@agentdesk/shared";
import type { RunnerClient } from "./client";
import type { RemoteRoutingStore } from "./store";

/** 用背压直接转发持久事件；流内持续校验会话，浏览器断开只结束订阅。 */
export class GatewayEvents {
  private readonly connections = new Map<string, Set<AbortController>>();
  constructor(
    private readonly client: RunnerClient,
    private readonly store: RemoteRoutingStore,
  ) {}

  async open(
    actor: RemoteActor,
    scope: RemoteScope,
    taskId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const connections = this.connections.get(actor.sessionId) ?? new Set<AbortController>();
    if (connections.size >= 4)
      throw new AppError(ErrorCode.RateLimited, "事件订阅过多，请关闭多余任务页面");
    const abort = new AbortController();
    connections.add(abort);
    this.connections.set(actor.sessionId, connections);
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) abort.abort();
    let timer: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    let stopStream: (() => void) | undefined;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      if (stopStream) abort.signal.removeEventListener("abort", stopStream);
      abort.abort();
      connections.delete(abort);
      if (!connections.size) this.connections.delete(actor.sessionId);
    };
    try {
      if (!this.store.sessionAlive(actor)) throw new AppError(ErrorCode.Unauthorized, "登录已过期");
      await this.client.grant(scope);
      const payload = { taskId, after };
      const response = await this.client.request(
        `/tasks/${taskId}/events`,
        {
          command: this.client.command(scope, actor, "task.read", payload),
          payload,
        },
        { signal: abort.signal, stream: true },
      );
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
        throw new AppError(ErrorCode.ServiceUnavailable, "执行宿主返回了无效事件流");
      const reader = response.body.getReader();
      return new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            stopStream = () => {
              if (finished) return;
              cleanup();
              void reader.cancel().catch(() => undefined);
              controller.close();
            };
            abort.signal.addEventListener("abort", stopStream, { once: true });
            if (abort.signal.aborted) {
              stopStream();
              return;
            }
            timer = setInterval(() => {
              if (!this.store.sessionAlive(actor)) {
                cleanup();
                void reader.cancel().catch(() => undefined);
                controller.error(new Error("Session expired"));
              }
            }, 1000);
            timer.unref();
          },
          pull: async (controller) => {
            try {
              if (!this.store.sessionAlive(actor))
                throw new AppError(ErrorCode.Unauthorized, "登录已过期");
              const next = await reader.read();
              if (finished) return;
              if (next.done) {
                cleanup();
                controller.close();
                return;
              }
              if (!this.store.sessionAlive(actor))
                throw new AppError(ErrorCode.Unauthorized, "登录已过期");
              controller.enqueue(next.value);
            } catch (error) {
              if (!finished) {
                cleanup();
                controller.error(error);
              }
              await reader.cancel().catch(() => undefined);
            }
          },
          cancel: async () => {
            cleanup();
            await reader.cancel().catch(() => undefined);
          },
        },
        { highWaterMark: 0 },
      );
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  closeSession(sessionId: string): void {
    for (const controller of this.connections.get(sessionId) ?? []) controller.abort();
  }
  closeAll(): void {
    for (const sessionId of [...this.connections.keys()]) this.closeSession(sessionId);
  }
}

type Listener = (event: unknown) => void;

/**
 * 进程内事件总线。运行类频道（部署、工作流）保留最近事件，
 * 让晚于任务启动才连上的 SSE 客户端也能回放完整过程。
 */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly buffers = new Map<string, unknown[]>();

  constructor(private readonly bufferSize = 1000) {}

  publish(channel: string, event: unknown): void {
    const buffer = this.buffers.get(channel);
    if (buffer) {
      buffer.push(event);
      if (buffer.length > this.bufferSize) buffer.shift();
    }
    for (const listener of this.listeners.get(channel) ?? []) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }

  /** 为频道开启回放缓冲，ttlMs 后自动清理 */
  retain(channel: string, ttlMs = 30 * 60_000): void {
    if (!this.buffers.has(channel)) this.buffers.set(channel, []);
    setTimeout(() => this.buffers.delete(channel), ttlMs).unref?.();
  }

  replay(channel: string): unknown[] {
    return [...(this.buffers.get(channel) ?? [])];
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(channel);
    };
  }
}

export const GLOBAL_CHANNEL = "global";

export type GlobalEvent =
  | { type: "approval"; approvalId: string }
  | { type: "notification"; title: string; body: string }
  | { type: "feed_updated"; date: string }
  | { type: "deploy_updated"; runId: string; status: string }
  | { type: "workflow_updated"; runId: string; status: string };

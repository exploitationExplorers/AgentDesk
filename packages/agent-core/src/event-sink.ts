import type { AgentStreamEvent } from "@agentdesk/shared";

/** SDK 事件入口保持同步；有界队列按顺序提交，工具与结果通过 flush 等待持久化。 */
export class OrderedEventSink {
  private tail?: Promise<void>;
  private failure?: unknown;
  private failed = false;
  private pending = 0;
  private bytes = 0;
  constructor(private readonly write: (event: AgentStreamEvent) => unknown) {}

  readonly emit = (event: AgentStreamEvent): void => {
    if (this.failed) throw this.failure;
    const bytes = JSON.stringify(event).length * 2;
    if (this.pending >= 4096 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.failed = true;
      this.failure = new Error("Agent event persistence queue exceeded its capacity");
      throw this.failure;
    }
    if (!this.tail) {
      const result = this.write(event);
      if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
      this.track(Promise.resolve(result), bytes);
    } else {
      this.track(
        this.tail.then(() => {
          if (this.failed) throw this.failure;
          return this.write(event);
        }),
        bytes,
      );
    }
  };

  private track(pending: Promise<unknown>, bytes: number) {
    this.pending++;
    this.bytes += bytes;
    const tail = pending
      .then(
        () => undefined,
        (error) => {
          if (!this.failed) {
            this.failed = true;
            this.failure = error;
          }
        },
      )
      .finally(() => {
        this.pending--;
        this.bytes -= bytes;
        if (this.tail === tail) this.tail = undefined;
      });
    this.tail = tail;
  }

  readonly flush = async (): Promise<void> => {
    while (this.tail) await this.tail;
    if (this.failed) throw this.failure;
  };
}

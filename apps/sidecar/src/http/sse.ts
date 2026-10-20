import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventHub } from "../events";

/**
 * 把事件总线频道转成 SSE：先回放缓冲事件，再推送实时事件。
 * isTerminal 返回 true 时结束流。
 */
export function channelToSse(
  c: Context,
  hub: EventHub,
  channel: string,
  isTerminal: (event: unknown) => boolean = () => false,
) {
  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    const push = (event: unknown) => {
      queue.push(event);
      wake?.();
    };

    for (const event of hub.replay(channel)) queue.push(event);
    const unsubscribe = hub.subscribe(channel, push);
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });

    const heartbeat = setInterval(() => push({ type: "ping" }), 15_000);
    try {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        const event = queue.shift();
        await stream.writeSSE({ data: JSON.stringify(event) });
        if (isTerminal(event)) break;
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}

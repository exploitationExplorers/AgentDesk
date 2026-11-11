import type { AgentStreamEvent } from "@agentdesk/shared";

/** 合并同一 Agent 连续的文本增量，阶段事件仍按原顺序立即交付。 */
export function createChatEventBuffer(
  consume: (events: AgentStreamEvent[]) => void,
  { signal, delayMs = 40 }: { signal: AbortSignal; delayMs?: number },
) {
  let pending: AgentStreamEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = signal.aborted;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    clearTimer();
    if (disposed || !pending.length) return;
    const events = pending;
    pending = [];
    consume(events);
  };
  const dispose = () => {
    disposed = true;
    clearTimer();
    pending = [];
    signal.removeEventListener("abort", dispose);
  };
  if (!disposed) signal.addEventListener("abort", dispose, { once: true });

  return {
    push(event: AgentStreamEvent) {
      if (disposed) return;
      const last = pending.at(-1);
      if (event.type === "text_delta" && last?.type === "text_delta" && last.agent === event.agent)
        pending[pending.length - 1] = { ...last, delta: last.delta + event.delta };
      else pending.push(event);
      if (event.type !== "text_delta") flush();
      else if (timer === undefined) timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose,
  };
}

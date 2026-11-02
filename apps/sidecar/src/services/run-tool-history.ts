import type { TaskStreamEvent, ToolCallRecord } from "@agentdesk/shared";
import type { TaskService } from "./tasks";

/** 只从工具开始与最终结果还原操作，流式文本、token 用量和中间输出不代表执行完成。 */
export class RunToolHistory {
  private readonly calls: ToolCallRecord[] = [];
  private readonly pending = new Map<string, ToolCallRecord>();

  append(event: TaskStreamEvent): void {
    if (event.type === "tool_call") {
      const call: ToolCallRecord = {
        id: event.id,
        name: event.name,
        args: event.args,
        agent: event.agent,
      };
      this.calls.push(call);
      this.pending.set(`${event.agent}:${event.id}`, call);
    } else if (event.type === "tool_result") {
      const key = `${event.agent}:${event.id}`;
      const call = this.pending.get(key);
      if (!call) return;
      call.result = event.result;
      call.isError = event.isError;
      this.pending.delete(key);
    }
  }

  list(): ToolCallRecord[] {
    return this.calls.map((call) => ({ ...call }));
  }
}

/** 按 Run 分页恢复完整操作历史，避免输出事件过多时漏掉最后的工具结果。 */
export function readRunToolHistory(
  tasks: Pick<TaskService, "eventsAfter">,
  runId: string,
): ToolCallRecord[] {
  const history = new RunToolHistory();
  let after = 0;
  for (;;) {
    const events = tasks.eventsAfter({ runId, after, limit: 500 });
    for (const record of events) history.append(record.event);
    if (events.length < 500) return history.list();
    after = events.at(-1)!.seq;
  }
}

export function summarizeToolCalls(records: ToolCallRecord[]): string {
  return records
    .map((call) => {
      const args = JSON.stringify(call.args ?? {}).slice(0, 200);
      if (call.isError === undefined) {
        return `${call.name}(${args}) → 结果未确认；可能已产生副作用，请先核对目标状态，勿直接重复执行`;
      }
      const result = (
        typeof call.result === "string" ? call.result : JSON.stringify(call.result ?? null)
      ).slice(0, 200);
      return `${call.name}(${args}) → ${call.isError ? "失败" : "完成"}：${result}`;
    })
    .join("；");
}

export function failedRunMessage(error: string, calls: ToolCallRecord[]): string {
  return `出错了：${error}${calls.length ? `\n\n本轮已记录的操作（续跑时跳过已确认完成的操作）：${summarizeToolCalls(calls)}` : ""}`;
}

import type { HubResult } from "@agentdesk/integrations";
import type { TaskService } from "../tasks";
import type { AutoloopStore, OutboxCommand } from "./store";

/** 只有 Hub 确认接收后才推进公开状态；重发回执也走同一事务。 */
export function settleReceipt(
  store: AutoloopStore,
  tasks: TaskService,
  entry: OutboxCommand,
): void {
  if (entry.operation !== "result" || entry.status !== "delivered" || !entry.linkId) return;
  store.db.transaction(() => {
    store.assertEpoch();
    const link = store.links.get(entry.linkId!);
    if (!link || link.state === "submitted") return;
    const result = JSON.parse(entry.body) as HubResult;
    const cancelled = result.outcome === "cancelled" || Boolean(store.stopped.get(link.taskId));
    const status = cancelled ? "cancelled" : result.outcome === "failed" ? "failed" : "succeeded";
    tasks.finalizeRunDirect(link.runId, {
      status,
      resultText: entry.outcome?.text ?? result.summary,
      resultError: result.error,
      toolCalls: entry.outcome?.toolCalls,
    });
    if (tasks.get(link.taskId)?.currentRunId === link.runId)
      tasks.setAutomationStatus(
        link.taskId,
        cancelled ? "cancelled" : (entry.outcome?.status ?? "needs_attention"),
      );
    tasks.appendEvent({
      taskId: link.taskId,
      runId: link.runId,
      event: { type: "run_ended", runId: link.runId, status },
    });
    store.links.put({ ...link, state: "submitted" });
  });
}

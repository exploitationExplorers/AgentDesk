import type { HubResult } from "@agentdesk/integrations";
import type { TaskService } from "../tasks";
import type { AutoloopStore, OutboxCommand } from "./store";
/** 只有 Hub 确认接收后才推进公开状态；重发回执也走同一事务。 */
export async function settleReceipt(
  store: AutoloopStore,
  tasks: TaskService,
  entry: OutboxCommand,
): Promise<void> {
  if (entry.operation !== "result" || entry.status !== "delivered" || !entry.linkId) return;
  await tasks.transaction(async () => {
    store.assertEpoch();
    const link = store.links.get(entry.linkId!);
    if (!link || link.state === "submitted") return;
    const result = JSON.parse(entry.body) as HubResult;
    const cancelled = result.outcome === "cancelled" || Boolean(store.stopped.get(link.taskId));
    const status = cancelled ? "cancelled" : result.outcome === "failed" ? "failed" : "succeeded";
    await tasks.finalizeRunDirect(link.runId, {
      status,
      resultText: entry.outcome?.text ?? result.summary,
      resultError: result.error,
      toolCalls: entry.outcome?.toolCalls,
    });
    if ((await tasks.get(link.taskId))?.currentRunId === link.runId)
      await tasks.setAutomationStatus(
        link.taskId,
        cancelled ? "cancelled" : (entry.outcome?.status ?? "needs_attention"),
      );
    await tasks.appendEvent({
      taskId: link.taskId,
      runId: link.runId,
      event: { type: "run_ended", runId: link.runId, status },
    });
    store.links.put({ ...link, state: "submitted" });
  });
}

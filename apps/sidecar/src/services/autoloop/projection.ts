import { z } from "zod";
import type { HubFact } from "@agentdesk/integrations";
import type { AutomationCard } from "@agentdesk/shared";
import type { TaskService } from "../tasks";
import { nowIso } from "../../util";
import { stableId, type AutoloopStore } from "./store";
const remoteCard = z.object({
  id: z.number().int().positive(),
  version: z.number().int().positive(),
  key: z.string(),
  run_id: z.number().nullable(),
  rule: z.string(),
  kind: z.enum(["ask", "notice"]),
  state: z.enum(["open", "decided", "done", "closed"]),
  title: z.string(),
  text: z.string(),
  options: z.string().nullable(),
  answer: z.string().nullable(),
  choice: z.number().nullable(),
  created_at: z.string(),
});
/** 白名单映射与事实游标原子保存，不把上游 token、配置或原始日志传到客户端。 */
export async function projectFact(
  store: AutoloopStore,
  tasks: TaskService,
  fact: HubFact,
): Promise<void> {
  await tasks.transaction(async () => {
    store.assertEpoch();
    if (fact.seq <= (store.state.get("cursor")?.value ?? 0)) return;
    for (const change of fact.changes) {
      if (change.table !== "cards" || !change.row) continue;
      const parsed = remoteCard.safeParse(change.row);
      if (!parsed.success) continue;
      const remote = parsed.data;
      const binding = store.bindings
        .list()
        .find((b) => remote.rule === b.ruleName || remote.rule === `${b.ruleName}-schedule`);
      if (!binding) continue;
      const link = store.links.list().find((l) => l.remoteRunId === remote.run_id);
      const id = stableId("local", "card", remote.id);
      const existing = store.cards.get(id);
      if (existing && existing.version > remote.version) continue;
      store.interactionKeys.put({
        id: String(remote.id),
        key: remote.key,
        choice: remote.choice,
        answer: remote.answer,
      });
      const options = z.array(z.string()).parse(JSON.parse(remote.options ?? "[]"));
      const checkpoint = link ? store.checkpoints.get(link.taskId)?.checkpoint : undefined;
      const card: AutomationCard = {
        id,
        bindingId: binding.id,
        hubId: "local",
        remoteCardId: String(remote.id),
        version: remote.version,
        kind: remote.kind,
        state: remote.state === "closed" ? "done" : remote.state,
        interactionKind:
          remote.kind === "notice"
            ? "notice"
            : (existing?.interactionKind ?? checkpoint?.suspension?.kind ?? "input"),
        taskId: link?.taskId ?? existing?.taskId ?? null,
        title: remote.title,
        description: remote.text,
        options,
        answerId: existing?.answerId ?? null,
        answerText:
          remote.choice !== null ? (options[remote.choice] ?? remote.answer) : remote.answer,
        createdAt: remote.created_at,
        updatedAt: nowIso(),
      };
      store.cards.put(card);
      if (card.taskId && store.stopped.get(card.taskId) && card.state === "open") {
        store.enqueue({
          id: stableId("resolve", card.id),
          operation: "resolve",
          target: remote.id,
          body: JSON.stringify({ reason: "任务已停止" }),
        });
      }
      if (card.taskId && link) {
        await tasks.appendEvent({
          taskId: card.taskId,
          runId: link.runId,
          event: {
            type: card.state === "open" ? "interaction_required" : "interaction_resolved",
            card,
          },
        });
        if (
          card.state === "open" &&
          card.kind === "ask" &&
          !store.stopped.get(card.taskId) &&
          (await tasks.get(card.taskId))?.currentRunId === link.runId
        )
          await tasks.setAutomationStatus(
            card.taskId,
            card.interactionKind === "authorization" ? "waiting_authorization" : "waiting_input",
          );
      }
    }
    store.state.put({ id: "cursor", value: fact.seq });
  });
}

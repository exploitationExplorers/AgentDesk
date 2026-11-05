import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  AgentName,
  AppError,
  ErrorCode,
  type AgentStreamEvent,
  type SessionWorkbench,
  type TaskStreamEvent,
} from "@agentdesk/shared";
import type { Container } from "../../container";
import { runEvents, traces } from "../../db/schema";
import { acquireConversation, conversationActivity } from "../../services/conversation-activity";
import { errorMessage, nowIso, toJsonSafe } from "../../util";

export function sessionWorkbenchRoutes(container: Container) {
  const app = new Hono();
  const { chat, tasks, context, approvals, dbHandle } = container;
  const history = (id: string, taskId?: string): TaskStreamEvent[] =>
    taskId
      ? dbHandle.db
          .select()
          .from(runEvents)
          .where(eq(runEvents.taskId, taskId))
          .orderBy(desc(runEvents.id))
          .limit(500)
          .all()
          .reverse()
          .map((row) => row.event as TaskStreamEvent)
      : chat.traces(id).map((row) => row.event as AgentStreamEvent);

  app.get("/conversations/:id/workbench", async (c) => {
    const id = c.req.param("id");
    const conversation = chat.getConversation(id);
    const task = tasks.findByConversation(id) ?? null;
    const events = history(id, task?.id);
    const latestUsage = events.filter((event) => event.type === "model_usage").at(-1) ?? null;
    const lastCompaction =
      events.filter((event) => event.type === "context_compaction").at(-1) ?? null;
    const approvalIds = new Set(
      events.filter((event) => event.type === "approval_required").map((event) => event.approvalId),
    );
    let status: SessionWorkbench["context"] = null;
    let contextError: string | null = null;
    try {
      status = await context.inspect({
        conversationId: id,
        agent: c.req.query("agent")
          ? AgentName.parse(c.req.query("agent"))
          : (latestUsage?.agent ?? task?.agent ?? undefined),
      });
    } catch (error) {
      contextError = errorMessage(error);
    }
    const pending = approvals
      .list("pending")
      .filter(
        (approval) =>
          approvalIds.has(approval.id) ||
          (task && (approval.payload as { taskId?: string } | null)?.taskId === task.id),
      );
    const result: SessionWorkbench = {
      conversation,
      workspace: chat.conversationWorkspace(id) ?? null,
      task,
      runs: task ? tasks.listRuns(task.id) : [],
      artifacts: task ? tasks.listArtifacts(task.id) : [],
      usedTools: [
        ...new Set(events.filter((event) => event.type === "tool_call").map((event) => event.name)),
      ],
      pendingApprovals: pending.length,
      pendingApprovalIds: pending.map((approval) => approval.id),
      activity:
        conversationActivity(id) ??
        (task && ["running", "queued"].includes(task.status) ? "running" : null),
      context: status,
      contextError,
      latestUsage,
      lastCompaction,
    };
    return c.json(result);
  });

  app.post("/conversations/:id/compact", async (c) => {
    const id = c.req.param("id");
    chat.getConversation(id);
    const task = tasks.findByConversation(id);
    if (task && ["running", "queued"].includes(task.status))
      throw new AppError(ErrorCode.Conflict, "请等待当前任务结束后再压缩");
    const release = acquireConversation(id, "compacting");
    try {
      return c.json(
        await context.compact({
          conversationId: id,
          agent: c.req.query("agent")
            ? AgentName.parse(c.req.query("agent"))
            : (task?.agent ?? undefined),
          signal: c.req.raw.signal,
          emit: (event) => {
            dbHandle.db
              .insert(traces)
              .values({ scope: `chat:${id}`, event: toJsonSafe(event), createdAt: nowIso() })
              .run();
            if (task?.currentRunId)
              tasks.appendEvent({ taskId: task.id, runId: task.currentRunId, event });
          },
        }),
      );
    } finally {
      release();
    }
  });
  return app;
}

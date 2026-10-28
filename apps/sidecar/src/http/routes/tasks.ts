import { Hono } from "hono";
import { z } from "zod";
import {
  AgentName,
  AppError,
  ErrorCode,
  RunTrigger,
  TaskStatus,
  type Conversation,
} from "@agentdesk/shared";
import type { Container } from "../../container";
import { Collection } from "../../db/collection";
import { newId, nowIso } from "../../util";
import { taskChannelToSse } from "../task-sse";

const CreateTaskBody = z.object({
  goal: z.string().min(1),
  title: z.string().optional(),
  agent: AgentName.optional(),
  requiresPlanApproval: z.boolean().optional(),
  conversationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  workspace: z.string().min(1).max(4096).optional(),
});

const CreateRunBody = z.object({
  trigger: RunTrigger,
  message: z.string().min(1),
  idempotencyKey: z.string().optional(),
  workspace: z.string().min(1).max(4096).optional(),
});

const ReviewBody = z.object({
  approved: z.boolean(),
  /** 仅在 approved=false 时有意义：retry 回到 running 继续修，abandon 直接判失败。 */
  outcome: z.enum(["retry", "abandon"]).optional(),
  note: z.string().optional(),
});

export function taskRoutes({ tasks, approvals, hub, dbHandle, projectInstructions }: Container) {
  const app = new Hono();
  // 本阶段不抽取共用的 conversation-store：POST /tasks 自动建会话时直接复用
  // ChatService 创建 Conversation 的逻辑，允许少量临时重复（见开发任务.md 阶段 B 范围说明）。
  const conversations = new Collection<Conversation>(dbHandle.db, "conversations");

  app.post("/tasks", async (c) => {
    const body = CreateTaskBody.parse(await c.req.json());
    const workspace = await projectInstructions.validateWorkspace(body.workspace);
    let conversationId = body.conversationId;
    if (!conversationId) {
      const conversation = conversations.put({
        id: newId(),
        title: body.goal.slice(0, 40),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      conversationId = conversation.id;
    }
    const task = tasks.create({
      title: body.title,
      goal: body.goal,
      agent: body.agent ?? null,
      conversationId,
      requiresPlanApproval: body.requiresPlanApproval ?? false,
    });
    const run = tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: body.agent ?? "orchestrator",
      trigger: "create",
      idempotencyKey: body.idempotencyKey,
      input: { userMessage: body.goal, workspace },
    });
    const queued = tasks.transition(task.id, "queued");
    tasks.enqueue(run.id);
    return c.json(queued, 201);
  });

  app.get("/tasks", (c) => {
    const statusQuery = c.req.query("status");
    const status = statusQuery ? TaskStatus.parse(statusQuery) : undefined;
    return c.json(tasks.list(status ? { status } : undefined));
  });

  app.get("/tasks/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return c.json(task);
  });

  app.post("/tasks/:id/runs", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (task.status === "closed")
      throw new AppError(ErrorCode.Conflict, "任务已关闭，不能新建运行");
    const body = CreateRunBody.parse(await c.req.json());
    const workspace = await projectInstructions.validateWorkspace(body.workspace);
    const run = tasks.createRun({
      taskId: id,
      kind: "root",
      agent: task.agent ?? "orchestrator",
      trigger: body.trigger,
      idempotencyKey: body.idempotencyKey,
      input: { userMessage: body.message, workspace },
    });
    tasks.enqueue(run.id);
    return c.json(run, 201);
  });

  app.get("/tasks/:id/events", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(c.req.query("after") ?? 0);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(c.req.query("limit") ?? 200);
    return c.json(tasks.eventsAfter({ taskId: id, after, limit }));
  });

  app.get("/tasks/:id/runs", (c) => {
    if (!tasks.get(c.req.param("id"))) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return c.json(tasks.listRuns(c.req.param("id")));
  });

  app.get("/tasks/:id/artifacts", (c) => {
    if (!tasks.get(c.req.param("id"))) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return c.json(tasks.listArtifacts(c.req.param("id")));
  });

  app.get("/tasks/:id/stream", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    const after = Number(c.req.query("after") ?? 0);
    return taskChannelToSse(
      c,
      hub,
      tasks,
      `task:${id}`,
      { taskId: id },
      after,
      (record) => record.event.type === "run_ended" && record.parentRunId === null,
    );
  });

  app.post("/tasks/:id/cancel", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return c.json(tasks.cancelTask(id));
  });

  /** 用户确认归档：只有 completed/failed/cancelled 这类终态可以关闭，幂等。 */
  app.post("/tasks/:id/close", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return c.json(tasks.close(id));
  });

  /**
   * 验收审批：approve -> completed；reject -> 按 outcome 区分继续修（running）还是放弃（failed）。
   * requiresPlanApproval 的任务在进入 awaiting_review 时已经真正创建了一条 kind='review' 的
   * Approval 记录（见 task-executor.ts）；其它任务没有主动创建（避免给每个任务都挂一条永不过期
   * 的 pending 审批），这里懒创建兜底——同样落一条真实记录再 resolve，而不是凭空接受请求。
   */
  app.post("/tasks/:id/review", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (task.status !== "awaiting_review") {
      throw new AppError(ErrorCode.Conflict, "任务当前不在待审核状态");
    }
    const body = ReviewBody.parse(await c.req.json());
    const pending = approvals
      .list("pending")
      .find((a) => a.kind === "review" && (a.payload as { taskId?: string } | null)?.taskId === id);
    const approval =
      pending ??
      approvals.create({
        kind: "review",
        title: `验收：${task.title}`,
        detail: task.goal,
        risk: "confirm",
        payload: { taskId: id, runId: task.currentRunId },
      }).approval;
    approvals.resolve(approval.id, body.approved);
    const next = body.approved ? "completed" : body.outcome === "abandon" ? "failed" : "running";
    return c.json(tasks.transition(id, next));
  });

  app.get("/runs/:id/events", (c) => {
    const id = c.req.param("id");
    const run = tasks.getRun(id);
    if (!run) throw new AppError(ErrorCode.NotFound, "运行不存在");
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 200);
    return c.json(tasks.eventsAfter({ runId: id, after, limit }));
  });

  app.get("/runs/:id/stream", (c) => {
    const id = c.req.param("id");
    const run = tasks.getRun(id);
    if (!run) throw new AppError(ErrorCode.NotFound, "运行不存在");
    const after = Number(c.req.query("after") ?? 0);
    return taskChannelToSse(
      c,
      hub,
      tasks,
      `run:${id}`,
      { runId: id },
      after,
      (record) => record.event.type === "run_ended" && record.runId === id,
    );
  });

  app.post("/runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    return c.json(tasks.requestCancel(id));
  });

  return app;
}

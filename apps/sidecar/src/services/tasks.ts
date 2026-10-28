import { and, asc, eq, gt, max } from "drizzle-orm";
import {
  AppError,
  ErrorCode,
  type AgentName,
  type Artifact,
  type ArtifactKind,
  type Run,
  type RunKind,
  type RunStatus,
  type RunTrigger,
  type Task,
  type TaskStatus,
  type TaskStreamEvent,
  type ToolCallRecord,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import type { EventHub } from "../events";
import { artifacts, runEvents, runs } from "../db/schema";
import { errorMessage, newId, nowIso, toJsonSafe } from "../util";

/** 任务状态机的合法迁移表，迁移前必须在此声明。 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["queued"],
  queued: ["planning", "running", "cancelled"],
  planning: ["awaiting_plan_approval", "running", "failed", "cancelled"],
  awaiting_plan_approval: ["running", "planning", "cancelled"],
  // "awaiting_plan_approval" 补在这里：方案关口的根 Run 在队列调度层面仍然走统一的
  // running 执行路径（见 executeRun），只是它的成功结果会被 RunOutcome.nextTaskStatus
  // 覆盖为 awaiting_plan_approval，而不是默认的 awaiting_review。
  running: ["awaiting_review", "awaiting_plan_approval", "failed", "cancelled"],
  awaiting_review: ["completed", "running", "failed"],
  completed: ["closed"],
  failed: ["queued", "closed"],
  cancelled: ["queued", "closed"],
  closed: [],
};

export interface TaskCreateInput {
  title?: string;
  goal: string;
  agent?: AgentName | null;
  conversationId: string;
  requiresPlanApproval: boolean;
}

export interface CreateRunInput {
  taskId: string;
  parentRunId?: string | null;
  kind: RunKind;
  agent: AgentName;
  trigger: RunTrigger;
  idempotencyKey?: string | null;
  input: { userMessage: string; context?: string; workspace?: string };
}

export interface RecordArtifactInput {
  taskId: string;
  runId?: string | null;
  kind: ArtifactKind;
  title: string;
  content?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  metadata?: unknown;
}

export interface AppendEventInput {
  taskId: string;
  runId: string;
  parentRunId?: string | null;
  event: TaskStreamEvent;
}

export interface RunEventRecord {
  seq: number;
  taskId: string;
  runId: string;
  parentRunId: string | null;
  event: TaskStreamEvent;
  createdAt: string;
}

/** Run 执行完成后的结果。真正调用 orchestrator 的实现见 task-executor.ts 的 createOrchestratorExecutor。 */
export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  resultText?: string;
  resultError?: string;
  /** 本次执行产生的工具调用记录，供 TASK-05 的续跑摘要拼装读取。 */
  toolCalls?: ToolCallRecord[];
  /**
   * 覆盖 succeeded/failed/cancelled 默认映射到的任务状态。方案关口场景下，一次成功的
   * 根 Run 不应该走默认的 awaiting_review，而是停在 awaiting_plan_approval 等待方案批准。
   */
  nextTaskStatus?: TaskStatus;
}

export type RunExecutor = (run: Run, task: Task, signal: AbortSignal) => Promise<RunOutcome>;

export interface TaskServiceOptions {
  maxConcurrentRuns?: number;
  executor?: RunExecutor;
}

export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** 默认占位实现：不调用任何真实 Agent，只是把 Run 标成功。生产环境由 container.ts 注入真实 executor。 */
const placeholderExecutor: RunExecutor = async (run) => ({
  status: "succeeded",
  resultText: `占位执行完成（阶段 D 之前的占位实现）：${run.input.userMessage}`,
});

/** Task/Run/Artifact 的裸持久化服务：CRUD + 状态机校验 + 幂等 Run + 产物版本管理 + 并发队列调度。 */
export class TaskService {
  private readonly tasks: Collection<Task>;
  private readonly maxConcurrentRuns: number;
  private readonly executor: RunExecutor;
  private readonly queue: string[] = [];
  private readonly runningSet = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    options: TaskServiceOptions = {},
  ) {
    this.tasks = new Collection<Task>(db, "tasks");
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.executor = options.executor ?? placeholderExecutor;
    this.recoverAfterRestart();
  }

  create(input: TaskCreateInput): Task {
    const now = nowIso();
    return this.tasks.put({
      id: newId(),
      title: input.title?.trim() || input.goal.slice(0, 40),
      goal: input.goal,
      agent: input.agent ?? null,
      conversationId: input.conversationId,
      requiresPlanApproval: input.requiresPlanApproval,
      status: "pending",
      currentRunId: null,
      pendingApprovalId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus }): Task[] {
    const all = this.tasks.list();
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }

  /** 按 conversationId 查找任务，供 ChatService 借壳接入复用同一个 Task。 */
  findByConversation(conversationId: string): Task | undefined {
    return this.tasks.list().find((t) => t.conversationId === conversationId);
  }

  transition(id: string, nextStatus: TaskStatus): Task {
    const task = this.tasks.get(id);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
      throw new AppError(ErrorCode.Conflict, `任务状态不能从 ${task.status} 迁移到 ${nextStatus}`);
    }
    return this.tasks.update(id, (t) => ({ ...t, status: nextStatus, updatedAt: nowIso() }))!;
  }

  /**
   * 相同 idempotencyKey 的重复调用只会真正 insert 一次，之后都返回首次创建的那条 run。
   * 方案关口硬校验：任务处于 awaiting_plan_approval 时，除了 trigger='followup'（追加修订方案
   * 的指令），任何新的根 Run 创建请求都直接拒绝——这是"未经批准不能越过方案关口"在服务层的
   * 强制点，不依赖 UI 隐藏按钮。followup 放行后任务先回到 planning（修订方案），不是重新 running。
   */
  createRun(input: CreateRunInput): Run {
    if (input.idempotencyKey) {
      const existing = this.db
        .select()
        .from(runs)
        .where(eq(runs.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing) return this.toRun(existing);
    }
    if (input.kind === "root") {
      const task = this.tasks.get(input.taskId);
      if (task?.status === "awaiting_plan_approval") {
        if (input.trigger !== "followup") {
          throw new AppError(ErrorCode.Conflict, "方案尚未批准，无法开始执行");
        }
        this.safeTransition(input.taskId, "planning");
      }
    }
    const task = this.tasks.get(input.taskId);
    const previousRunId = input.parentRunId ?? task?.currentRunId;
    const inheritedWorkspace = previousRunId
      ? this.getRun(previousRunId)?.input.workspace
      : undefined;
    const workspace = input.input.workspace ?? inheritedWorkspace;
    const row = {
      id: newId(),
      taskId: input.taskId,
      parentRunId: input.parentRunId ?? null,
      kind: input.kind,
      agent: input.agent,
      status: "queued" as RunStatus,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey ?? null,
      input: { ...input.input, ...(workspace ? { workspace } : {}) },
      resultText: null,
      resultError: null,
      toolCalls: null,
      cancelRequested: false,
      cancelRequestedAt: null,
      startedAt: null,
      endedAt: null,
      createdAt: nowIso(),
    };
    this.db.insert(runs).values(row).run();
    if (input.kind === "root")
      this.tasks.update(input.taskId, (t) => ({ ...t, currentRunId: row.id, updatedAt: nowIso() }));
    return this.toRun(row);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? this.toRun(row) : undefined;
  }

  listRuns(taskId: string): Run[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(runs.createdAt))
      .all()
      .map((row) => this.toRun(row));
  }

  /** 对话和委派由调用方驱动，但仍记录真实运行状态并接入取消通道。 */
  startRunDirect(runId: string, controller?: AbortController): void {
    const run = this.getRun(runId);
    if (!run) throw new AppError(ErrorCode.NotFound, "运行不存在");
    this.updateRunRow(runId, { status: "running", startedAt: nowIso() });
    if (controller) this.controllers.set(runId, controller);
    if (!run.parentRunId) {
      const task = this.get(run.taskId);
      if (task && ["pending", "failed", "cancelled"].includes(task.status))
        this.safeTransition(task.id, "queued");
      this.safeTransition(run.taskId, "running");
    }
    this.appendEvent({
      taskId: run.taskId,
      runId,
      parentRunId: run.parentRunId,
      event: {
        type: "run_started",
        runId,
        parentRunId: run.parentRunId,
        agent: run.agent,
        trigger: run.trigger,
      },
    });
  }

  requestCancel(runId: string): Run {
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) throw new AppError(ErrorCode.NotFound, "运行不存在");
    if (!row.cancelRequested) {
      this.db
        .update(runs)
        .set({ cancelRequested: true, cancelRequestedAt: nowIso() })
        .where(eq(runs.id, runId))
        .run();
    }
    // 持久化意图之外，如果该 run 正在执行，再真正尝试中止它
    this.controllers.get(runId)?.abort();
    return this.getRun(runId)!;
  }

  /** 取消任务：取消其当前运行（排队中则在领取时跳过，执行中则真正 abort），并把任务迁移到 cancelled。 */
  cancelTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (task.currentRunId) this.requestCancel(task.currentRunId);
    if (!TASK_TRANSITIONS[task.status].includes("cancelled")) return task;
    return this.transition(taskId, "cancelled");
  }

  /** 用户确认归档：只有终态（completed/failed/cancelled）才能关闭，幂等——已关闭直接原样返回。 */
  close(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (task.status === "closed") return task;
    if (!TASK_TRANSITIONS[task.status].includes("closed")) {
      throw new AppError(ErrorCode.Conflict, `任务状态 ${task.status} 不是终态，不能关闭`);
    }
    const closed = this.transition(taskId, "closed");
    return this.tasks.update(taskId, (t) => ({ ...t, closedAt: nowIso() })) ?? closed;
  }

  /** 排队进这条 Run，并尝试立即开始调度（受并发槛位限制）。 */
  enqueue(runId: string): void {
    this.queue.push(runId);
    void this.pump();
  }

  /** 从队首按序领取 Run，直到槛位占满或队列排空；每个槛位空出时会再调用一次自己。 */
  private async pump(): Promise<void> {
    while (this.queue.length > 0 && this.runningSet.size < this.maxConcurrentRuns) {
      const runId = this.queue.shift()!;
      const run = this.getRun(runId);
      if (!run || run.status !== "queued") continue;
      if (run.cancelRequested) {
        this.finalizeRun(run, { status: "cancelled", resultError: "排队期间被取消" });
        continue;
      }
      this.runningSet.add(runId);
      const controller = new AbortController();
      this.controllers.set(runId, controller);
      void this.executeRun(run, controller).finally(() => {
        this.runningSet.delete(runId);
        this.controllers.delete(runId);
        void this.pump();
      });
    }
  }

  private async executeRun(run: Run, controller: AbortController): Promise<void> {
    const task = this.tasks.get(run.taskId);
    const started = this.updateRunRow(run.id, { status: "running", startedAt: nowIso() });
    if (task) this.safeTransition(task.id, "running");
    try {
      const result = await this.executor(started, task!, controller.signal);
      this.finalizeRun(started, result);
    } catch (error) {
      this.finalizeRun(started, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        resultError: errorMessage(error),
      });
    }
  }

  private finalizeRun(run: Run, result: RunOutcome): void {
    this.writeRunResult(run, result);
    this.safeTransition(run.taskId, this.taskStatusFor(result));
  }

  /**
   * 直接落地 Run 终态、不经过队列调度（供 onDelegate 完成回调和 /chat 借壳 Run 使用）。
   * 子 Run（parentRunId 非空）只记录自己的终态；父任务当前阶段只应该由它自己的根 Run 决定，
   * 不能因为某一次委派先结束就被提前推进。
   */
  finalizeRunDirect(runId: string, outcome: RunOutcome): void {
    const run = this.getRun(runId);
    if (!run) return;
    this.writeRunResult(run, outcome);
    if (run.parentRunId === null) this.safeTransition(run.taskId, this.taskStatusFor(outcome));
    this.controllers.delete(runId);
  }

  private writeRunResult(run: Run, result: RunOutcome): Run {
    return this.updateRunRow(run.id, {
      status: result.status,
      resultText: result.resultText ?? null,
      resultError: result.resultError ?? null,
      toolCalls: result.toolCalls ?? null,
      endedAt: nowIso(),
    });
  }

  private taskStatusFor(result: RunOutcome): TaskStatus {
    if (result.nextTaskStatus) return result.nextTaskStatus;
    return result.status === "succeeded"
      ? "awaiting_review"
      : result.status === "failed"
        ? "failed"
        : "cancelled";
  }

  private updateRunRow(
    runId: string,
    patch: Partial<{
      status: RunStatus;
      startedAt: string | null;
      endedAt: string | null;
      resultText: string | null;
      resultError: string | null;
      toolCalls: ToolCallRecord[] | null;
    }>,
  ): Run {
    this.db.update(runs).set(patch).where(eq(runs.id, runId)).run();
    return this.getRun(runId)!;
  }

  /** 迁移非法时（任务已经处于其它合法终态，比如已被取消）直接跳过，不让调度流程因此中断。 */
  private safeTransition(taskId: string, status: TaskStatus): void {
    try {
      this.transition(taskId, status);
    } catch {
      // 忽略：任务状态机已经走到了其它分支
    }
  }

  /**
   * 构造函数末尾调用：恢复进程崩溃前的状态。
   * - status='running' 的 Run 从未被这个新实例领取过，视为中断，标 failed；
   *   若所属任务没有其它排队中的 Run，任务一并标 failed。
   * - status='queued' 的 Run 从未执行、没有任何副作用，按创建时间塞回内存队列重新调度。
   */
  private recoverAfterRestart(): void {
    const now = nowIso();
    const runningRows = this.db.select().from(runs).where(eq(runs.status, "running")).all();
    for (const row of runningRows) {
      this.db
        .update(runs)
        .set({ status: "failed", resultError: "sidecar 重启，任务中断", endedAt: now })
        .where(eq(runs.id, row.id))
        .run();
      const hasQueuedSibling = this.listRuns(row.taskId).some((r) => r.status === "queued");
      if (!hasQueuedSibling) this.safeTransition(row.taskId, "failed");
    }

    const queuedRows = this.db
      .select()
      .from(runs)
      .where(eq(runs.status, "queued"))
      .orderBy(asc(runs.createdAt))
      .all();
    for (const row of queuedRows) this.queue.push(row.id);
    if (this.queue.length > 0) void this.pump();
  }

  /** 写入一条 run_events 行并分别广播到 run 频道和 task 频道，返回的记录形状供快照 API 和 SSE 复用。 */
  appendEvent(input: AppendEventInput): RunEventRecord {
    if (input.event.type === "file_change") {
      const { change } = input.event;
      this.recordArtifact({
        taskId: input.taskId,
        runId: input.runId,
        kind: "change",
        title: change.path,
        filePath: change.path,
        content: change.diff,
        metadata: change,
      });
    }
    const createdAt = nowIso();
    const parentRunId = input.parentRunId ?? null;
    const result = this.db
      .insert(runEvents)
      .values({
        taskId: input.taskId,
        runId: input.runId,
        parentRunId,
        event: toJsonSafe(input.event),
        createdAt,
      })
      .run();
    const record: RunEventRecord = {
      seq: Number(result.lastInsertRowid),
      taskId: input.taskId,
      runId: input.runId,
      parentRunId,
      event: input.event,
      createdAt,
    };
    this.hub.publish(`run:${input.runId}`, record);
    this.hub.publish(`task:${input.taskId}`, record);
    return record;
  }

  eventsAfter(input: {
    taskId?: string;
    runId?: string;
    after: number;
    limit: number;
  }): RunEventRecord[] {
    const condition = input.runId
      ? and(eq(runEvents.runId, input.runId), gt(runEvents.id, input.after))
      : and(eq(runEvents.taskId, input.taskId!), gt(runEvents.id, input.after));
    return this.db
      .select()
      .from(runEvents)
      .where(condition)
      .orderBy(asc(runEvents.id))
      .limit(input.limit)
      .all()
      .map((row) => ({
        seq: row.id,
        taskId: row.taskId,
        runId: row.runId,
        parentRunId: row.parentRunId,
        event: row.event as TaskStreamEvent,
        createdAt: row.createdAt,
      }));
  }

  recordArtifact(input: RecordArtifactInput): Artifact {
    const version = this.nextArtifactVersion(input.taskId, input.kind);
    const row = {
      id: newId(),
      taskId: input.taskId,
      runId: input.runId ?? null,
      kind: input.kind,
      version,
      title: input.title,
      content: input.content ?? null,
      filePath: input.filePath ?? null,
      mimeType: input.mimeType ?? null,
      metadata: input.metadata ?? null,
      createdAt: nowIso(),
    };
    this.db.insert(artifacts).values(row).run();
    return this.toArtifact(row);
  }

  latestArtifact(taskId: string, kind: ArtifactKind): Artifact | undefined {
    return this.listArtifacts(taskId, kind).at(-1);
  }

  /**
   * 占位方法：独立 Agent 审查（reviewer）产出的审查结论落库入口。M2 阶段不会有任何代码路径
   * 自动调用它——reviewer 本阶段只负责"定义存在、能被按需调用"，真正接入由后续阶段决定。
   */
  recordReviewSummary(taskId: string, runId: string, content: string): Artifact {
    return this.recordArtifact({ taskId, runId, kind: "summary", title: "审查摘要", content });
  }

  listArtifacts(taskId: string, kind?: ArtifactKind): Artifact[] {
    const condition = kind
      ? and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind))
      : eq(artifacts.taskId, taskId);
    return this.db
      .select()
      .from(artifacts)
      .where(condition)
      .orderBy(asc(artifacts.version))
      .all()
      .map((row) => this.toArtifact(row));
  }

  private nextArtifactVersion(taskId: string, kind: ArtifactKind): number {
    const result = this.db
      .select({ maxVersion: max(artifacts.version) })
      .from(artifacts)
      .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind)))
      .get();
    return (result?.maxVersion ?? 0) + 1;
  }

  private toRun(row: typeof runs.$inferSelect): Run {
    return {
      ...row,
      kind: row.kind as RunKind,
      status: row.status as RunStatus,
      trigger: row.trigger as RunTrigger,
      agent: row.agent as AgentName,
      input: row.input as Run["input"],
      toolCalls: row.toolCalls as Run["toolCalls"],
    };
  }

  private toArtifact(row: typeof artifacts.$inferSelect): Artifact {
    return {
      ...row,
      kind: row.kind as ArtifactKind,
      metadata: row.metadata as Artifact["metadata"],
    };
  }
}

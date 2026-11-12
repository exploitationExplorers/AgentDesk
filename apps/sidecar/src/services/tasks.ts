import type Database from "better-sqlite3";
import type {
  TaskPersistence,
  AsyncDocumentRepository,
  AsyncEventStore,
} from "./storage/async-ports";
import { AsyncLocalStorage } from "node:async_hooks";
import { SqliteTaskPersistence } from "./storage/sqlite-task-persistence";
import { resolve } from "node:path";
import {
  AppError,
  ErrorCode,
  type AgentName,
  type AutomationStatus,
  type Artifact,
  type ArtifactKind,
  type ArtifactVersionInput,
  type Run,
  type RunKind,
  type RunStatus,
  type RunTrigger,
  type Task,
  type TaskStatus,
  type TaskStreamEvent,
  type ToolCallRecord,
} from "@agentdesk/shared";
import { artifactContent } from "./artifact-files";
import { conversationActivity } from "./conversation-activity";
import type { Db } from "../db/client";
import type { EventHub } from "../events";
import type { DocumentRepository, EventFilter, EventStore } from "./storage/ports";
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
  awaiting_review: ["completed", "running", "failed", "closed"],
  completed: ["closed"],
  failed: ["queued", "closed"],
  cancelled: ["queued", "closed"],
  closed: [],
};
export interface TaskCreateInput {
  automationId?: string;
  title?: string;
  goal: string;
  agent?: AgentName | null;
  conversationId: string;
  requiresPlanApproval: boolean;
  purpose?: Task["purpose"];
}
export interface CreateRunInput {
  executionOwner?: "local" | "autoloop";
  taskId: string;
  parentRunId?: string | null;
  kind: RunKind;
  agent: AgentName;
  trigger: RunTrigger;
  idempotencyKey?: string | null;
  input: {
    userMessage: string;
    context?: string;
    workspace?: string;
  };
  inheritWorkspace?: boolean;
  /** 仅供已持有本会话执行锁的内部聊天入口使用，仍须通过活动 Run 校验。 */
  conversationLockHeld?: boolean;
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
  artifactKey?: string;
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
  persistence?: TaskPersistence;
  taskRepository?: DocumentRepository<Task>;
  eventStore?: EventStore;
  beforeRun?: (run: Run) => Promise<void>;
  artifactRoot?: string;
  maxConcurrentRuns?: number;
  executor?: RunExecutor;
  /** 远程执行必须由运行入口重新校验身份、lease 和工作区；本地默认不允许远程排队。 */
  authorizeRemoteRun?: (run: Run) => void | Promise<void>;
}
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
/** 默认占位实现：不调用任何真实 Agent，只是把 Run 标成功。生产环境由 container.ts 注入真实 executor。 */
const placeholderExecutor: RunExecutor = async (run) => ({
  status: "succeeded",
  resultText: `占位执行完成（阶段 D 之前的占位实现）：${run.input.userMessage}`,
});
/** Task/Run/Artifact 的裸持久化服务：CRUD + 状态机校验 + 幂等 Run + 产物版本管理 + 并发队列调度。 */
export class TaskService {
  get business() {
    return this.persistence.business;
  }
  documents<
    T extends {
      id: string;
    },
  >(name: string) {
    return this.persistence.documents<T>(name);
  }
  private readonly artifactRoot?: string;
  readonly ready: Promise<void>;
  private readonly persistence: TaskPersistence;
  private readonly tasks: AsyncDocumentRepository<Task>;
  private readonly eventStore: AsyncEventStore;
  private readonly beforeRun?: (run: Run) => Promise<void>;
  private admission?: (workspace?: string) => Promise<void>;
  private readonly eventReaders = new Map<string, number>();
  private readonly historyMaintenance = new Set<string>();
  private readonly maxConcurrentRuns: number;
  private readonly executor: RunExecutor;
  private readonly authorizeRemoteRun?: (run: Run) => void | Promise<void>;
  private readonly queue: string[] = [];
  private readonly runningSet = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly externalSlots = new Set<symbol>();
  private readonly executions = new Set<Promise<void>>();
  private stopping = false;
  private pumping?: Promise<void>;
  private readonly notifications = new AsyncLocalStorage<Array<() => void>>();
  /** 业务资源图与事件共用事务，广播只在最外层提交成功后发出。 */
  async transaction<T>(action: () => Promise<T>): Promise<T> {
    await this.ready;
    if (this.notifications.getStore()) return this.persistence.transaction(action);
    const pending: Array<() => void> = [];
    const result = await this.persistence.transaction(() =>
      this.notifications.run(pending, action),
    );
    for (const notify of pending) this.persistence.business.afterCommit(notify);
    return result;
  }
  /** 停止领取排队任务，等待执行中的任务写完终态后再关闭数据库。 */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.pumping;
    await Promise.allSettled([...this.executions]);
  }
  constructor(
    db: Db,
    private readonly hub: EventHub,
    options: TaskServiceOptions = {},
  ) {
    this.persistence =
      options.persistence ??
      new SqliteTaskPersistence({
        db,
        raw: (
          db as Db & {
            $client: Database.Database;
          }
        ).$client,
        close: () => {},
      });
    this.tasks = options.taskRepository
      ? (new Proxy(options.taskRepository, {
          get: (target, key) =>
            typeof Reflect.get(target, key) === "function"
              ? (...args: unknown[]) =>
                  Promise.resolve(Reflect.apply(Reflect.get(target, key), target, args))
              : Reflect.get(target, key),
        }) as unknown as AsyncDocumentRepository<Task>)
      : this.persistence.tasks;
    this.eventStore = options.eventStore
      ? (new Proxy(options.eventStore, {
          get: (target, key) =>
            typeof Reflect.get(target, key) === "function"
              ? (...args: unknown[]) =>
                  Promise.resolve(Reflect.apply(Reflect.get(target, key), target, args))
              : Reflect.get(target, key),
        }) as unknown as AsyncEventStore)
      : this.persistence.events;
    this.beforeRun = options.beforeRun;
    this.artifactRoot = options.artifactRoot;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.executor = options.executor ?? placeholderExecutor;
    this.authorizeRemoteRun = options.authorizeRemoteRun;
    this.ready = this.recoverAfterRestart();
  }
  async create(input: TaskCreateInput): Promise<Task> {
    await this.ready;
    const now = nowIso();
    return await this.tasks.put({
      id: newId(),
      ...(input.automationId
        ? { automationId: input.automationId, automationStatus: "queued" as const }
        : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
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
  async get(id: string): Promise<Task | undefined> {
    await this.ready;
    return await this.tasks.get(id);
  }
  async list(filter?: { status?: TaskStatus }): Promise<Task[]> {
    await this.ready;
    const all = await this.tasks.list();
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }
  /** 按 conversationId 查找任务，供 ChatService 借壳接入复用同一个 Task。 */
  async findByConversation(conversationId: string): Promise<Task | undefined> {
    await this.ready;
    return (await this.tasks.list()).find((t) => t.conversationId === conversationId);
  }
  /** 创建根 Run 前检查整段会话，避免排队或执行中的任务被续跑请求覆盖。 */
  async assertConversationAvailable(
    conversationId: string,
    conversationLockHeld = false,
  ): Promise<void> {
    await this.ready;
    const activity = conversationActivity(conversationId);
    if (activity && !(conversationLockHeld && activity === "running")) {
      throw new AppError(ErrorCode.Conflict, "会话正在执行或压缩，请稍后再试");
    }
    const taskIds = (await this.tasks.list())
      .filter((task) => task.conversationId === conversationId)
      .map((task) => task.id);
    if (taskIds.length === 0) return;
    const activeRun = await this.persistence.runs.activeForTasks(taskIds);
    if (activeRun)
      throw new AppError(ErrorCode.Conflict, "会话已有排队或执行中的任务，请等待结束后再继续");
  }
  async transition(id: string, nextStatus: TaskStatus): Promise<Task> {
    return await this.transaction(async () => {
      const task = await this.tasks.get(id);
      if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
      if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
        throw new AppError(
          ErrorCode.Conflict,
          `任务状态不能从 ${task.status} 迁移到 ${nextStatus}`,
        );
      }
      return (await this.tasks.update(id, (t) => ({
        ...t,
        status: nextStatus,
        updatedAt: nowIso(),
      })))!;
    });
  }
  /**
   * 相同 idempotencyKey 的重复调用只会真正 insert 一次，之后都返回首次创建的那条 run。
   * 方案关口硬校验：任务处于 awaiting_plan_approval 时，除了 trigger='followup'（追加修订方案
   * 的指令），任何新的根 Run 创建请求都直接拒绝——这是"未经批准不能越过方案关口"在服务层的
   * 强制点，不依赖 UI 隐藏按钮。followup 放行后任务先回到 planning（修订方案），不是重新 running。
   */
  async createRun(input: CreateRunInput): Promise<Run> {
    return await this.transaction(async () => {
      if (input.idempotencyKey) {
        const existing = await this.persistence.runs.findByIdempotency(input.idempotencyKey);
        if (existing) {
          if (existing.taskId !== input.taskId)
            throw new AppError(ErrorCode.Conflict, "幂等键已用于其他任务");
          return this.toRun(existing);
        }
      }
      const task = await this.tasks.get(input.taskId);
      if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
      if (task.automationId && input.executionOwner !== "autoloop")
        throw new AppError(
          ErrorCode.Conflict,
          "自动化任务由后台调度，请使用任务中的回答或停止操作",
        );
      if (input.kind === "root") {
        if (task.status === "closed")
          throw new AppError(ErrorCode.Conflict, "任务已关闭，不能新建运行");
        if (
          task.purpose === "reference_analysis" &&
          (input.trigger !== "create" || (await this.listRuns(task.id)).length > 0)
        ) {
          throw new AppError(
            ErrorCode.Conflict,
            "资料分析不能直接续跑，请重新提交资料或选择建议创建开发任务",
          );
        }
        await this.assertConversationAvailable(task.conversationId, input.conversationLockHeld);
        if (task.status === "awaiting_plan_approval") {
          if (input.trigger !== "followup") {
            throw new AppError(ErrorCode.Conflict, "方案尚未批准，无法开始执行");
          }
          await this.safeTransition(input.taskId, "planning");
        }
      }
      const previousRunId = input.parentRunId ?? task.currentRunId;
      const inheritedWorkspace = previousRunId
        ? (await this.getRun(previousRunId))?.input.workspace
        : undefined;
      const workspace =
        input.input.workspace ??
        (input.inheritWorkspace === false ? undefined : inheritedWorkspace);
      const row = {
        id: newId(),
        taskId: input.taskId,
        parentRunId: input.parentRunId ?? null,
        kind: input.kind,
        agent: input.agent,
        status: "queued" as RunStatus,
        trigger: input.trigger,
        idempotencyKey: input.idempotencyKey ?? null,
        executionOwner: input.executionOwner ?? "local",
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
      await this.persistence.runs.insert(row as Run);
      if (input.kind === "root")
        await this.tasks.update(input.taskId, (t) => ({
          ...t,
          currentRunId: row.id,
          updatedAt: nowIso(),
        }));
      return this.toRun(row);
    });
  }
  async getRun(id: string): Promise<Run | undefined> {
    await this.ready;
    const row = await this.persistence.runs.get(id);
    return row ? this.toRun(row) : undefined;
  }
  async listRuns(taskId: string): Promise<Run[]> {
    await this.ready;
    return await this.persistence.runs.list(taskId);
  }
  /** 对话和委派由调用方驱动，但仍记录真实运行状态并接入取消通道。 */
  async startRunDirect(runId: string, controller?: AbortController): Promise<void> {
    return await this.transaction(async () => {
      if (this.stopping) throw new AppError(ErrorCode.Conflict, "任务服务正在关闭");
      const run = await this.getRun(runId);
      if (!run) throw new AppError(ErrorCode.NotFound, "运行不存在");
      await this.updateRunRow(runId, { status: "running", startedAt: nowIso() });
      this.business.afterCommit(() => {
        if (controller) this.controllers.set(runId, controller);
        if (run.executionOwner !== "autoloop") this.runningSet.add(runId);
      });
      if (!run.parentRunId) {
        const task = await this.get(run.taskId);
        if (task && ["pending", "failed", "cancelled"].includes(task.status))
          await this.safeTransition(task.id, "queued");
        await this.safeTransition(run.taskId, "running");
      }
      await this.appendEvent({
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
    });
  }
  async requestCancel(runId: string): Promise<Run> {
    await this.ready;
    const row = await this.persistence.runs.get(runId);
    if (!row) throw new AppError(ErrorCode.NotFound, "运行不存在");
    if (row.executionOwner === "autoloop")
      throw new AppError(ErrorCode.Conflict, "请通过自动化任务停止后台执行");
    if (!row.cancelRequested) {
      await this.persistence.runs.update(runId, {
        cancelRequested: true,
        cancelRequestedAt: nowIso(),
      });
    }
    // 持久化意图之外，如果该 run 正在执行，再真正尝试中止它
    this.business.afterCommit(() => this.controllers.get(runId)?.abort());
    return (await this.getRun(runId))!;
  }
  /** 取消任务：取消其当前运行（排队中则在领取时跳过，执行中则真正 abort），并把任务迁移到 cancelled。 */
  async cancelTask(taskId: string): Promise<Task> {
    return await this.transaction(async () => {
      const task = await this.tasks.get(taskId);
      if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
      if (task.automationId) throw new AppError(ErrorCode.Conflict, "请通过自动化任务停止后台执行");
      if (task.currentRunId) await this.requestCancel(task.currentRunId);
      if (!TASK_TRANSITIONS[task.status].includes("cancelled")) return task;
      return await this.transition(taskId, "cancelled");
    });
  }
  /** 用户确认归档：只有终态（completed/failed/cancelled）才能关闭，幂等——已关闭直接原样返回。 */
  async close(taskId: string): Promise<Task> {
    return await this.transaction(async () => {
      const task = await this.tasks.get(taskId);
      if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
      if (task.status === "closed") return task;
      if (!TASK_TRANSITIONS[task.status].includes("closed")) {
        throw new AppError(ErrorCode.Conflict, `任务状态 ${task.status} 不是终态，不能关闭`);
      }
      const closed = await this.transition(taskId, "closed");
      return (await this.tasks.update(taskId, (t) => ({ ...t, closedAt: nowIso() }))) ?? closed;
    });
  }
  /** 排队进这条 Run，并尝试立即开始调度（受并发槛位限制）。 */
  async enqueue(runId: string): Promise<void> {
    await this.ready;
    if (this.stopping) throw new AppError(ErrorCode.Conflict, "任务服务正在关闭");
    const run = await this.getRun(runId);
    if (run?.executionOwner === "autoloop")
      throw new AppError(ErrorCode.Conflict, "托管执行不能进入本地调度队列");
    if (run && (await this.isRemoteTask(run.taskId))) await this.checkRemoteRun(run);
    if (this.queue.includes(runId) || this.runningSet.has(runId)) return;
    this.queue.push(runId);
    await this.pump();
  }
  /** 从队首按序领取 Run，直到槛位占满或队列排空；每个槛位空出时会再调用一次自己。 */
  private async pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.drainQueue();
    try {
      await this.pumping;
    } finally {
      this.pumping = undefined;
    }
  }
  private schedulePump(): void {
    const pending = this.notifications.getStore();
    if (pending) {
      pending.push(() => this.notifications.exit(async () => await this.schedulePump()));
      return;
    }
    void this.pump().catch(() => {
      this.stopping = true;
      for (const controller of this.controllers.values()) controller.abort();
      console.error("[tasks] Persistence failed; scheduling stopped");
    });
  }
  private async drainQueue(): Promise<void> {
    while (
      !this.stopping &&
      this.queue.length > 0 &&
      this.runningSet.size + this.externalSlots.size < this.maxConcurrentRuns
    ) {
      const runId = this.queue.shift()!;
      const run = await this.getRun(runId);
      if (this.stopping) {
        this.queue.unshift(runId);
        break;
      }
      if (!run || run.status !== "queued" || run.executionOwner === "autoloop") continue;
      if (await this.isRemoteTask(run.taskId)) {
        try {
          await this.checkRemoteRun(run);
        } catch (error) {
          await this.finalizeRun(run, { status: "failed", resultError: errorMessage(error) });
          continue;
        }
      }
      if (run.cancelRequested) {
        await this.finalizeRun(run, { status: "cancelled", resultError: "排队期间被取消" });
        continue;
      }
      this.runningSet.add(runId);
      const controller = new AbortController();
      this.controllers.set(runId, controller);
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const execution = this.executeRun(run, controller, markStarted)
        .catch(() => {
          this.stopping = true;
          for (const active of this.controllers.values()) active.abort();
          console.error("[tasks] Run persistence failed; scheduling stopped");
        })
        .finally(async () => {
          this.executions.delete(execution);
          this.runningSet.delete(runId);
          this.controllers.delete(runId);
          await this.schedulePump();
        });
      this.executions.add(execution);
      await started;
    }
  }
  private async executeRun(
    run: Run,
    controller: AbortController,
    markStarted: () => void,
  ): Promise<void> {
    let started = run;
    try {
      const task = await this.tasks.get(run.taskId);
      if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
      await this.transaction(async () => {
        started = await this.updateRunRow(run.id, { status: "running", startedAt: nowIso() });
        {
          // 续跑必须先回到队列态，否则失败/取消的任务会拒绝 running 和最终成功状态。
          if (["pending", "failed", "cancelled"].includes(task.status))
            await this.safeTransition(task.id, "queued");
          await this.safeTransition(task.id, "running");
        }
      });
      if (this.beforeRun) await this.beforeRun(started);
      controller.signal.throwIfAborted();
      const pending = this.executor(started, task, controller.signal);
      markStarted();
      const result = await pending;
      await this.finalizeRun(started, result);
    } catch (error) {
      await this.finalizeRun(started, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        resultError: errorMessage(error),
      });
    } finally {
      markStarted();
    }
  }
  private async finalizeRun(run: Run, result: RunOutcome): Promise<void> {
    return await this.transaction(async () => {
      await this.writeRunResult(run, result);
      await this.safeTransition(run.taskId, this.taskStatusFor(result));
    });
  }
  /**
   * 直接落地 Run 终态、不经过队列调度（供 onDelegate 完成回调和 /chat 借壳 Run 使用）。
   * 子 Run（parentRunId 非空）只记录自己的终态；父任务当前阶段只应该由它自己的根 Run 决定，
   * 不能因为某一次委派先结束就被提前推进。
   */
  async finalizeRunDirect(runId: string, outcome: RunOutcome): Promise<void> {
    return await this.transaction(async () => {
      const run = await this.getRun(runId);
      if (!run) return;
      await this.writeRunResult(run, outcome);
      if (run.parentRunId === null && (await this.get(run.taskId))?.currentRunId === run.id)
        await this.safeTransition(run.taskId, this.taskStatusFor(outcome));
      this.business.afterCommit(() => {
        this.controllers.delete(runId);
        this.runningSet.delete(runId);
        this.schedulePump();
      });
    });
  }
  /** 先保留本机额度再向 Hub claim，避免领取后长时间排队。 */
  reserveExternalSlot(): (() => void) | undefined {
    if (this.stopping) return undefined;
    if (this.runningSet.size + this.externalSlots.size >= this.maxConcurrentRuns) return undefined;
    const key = Symbol();
    this.externalSlots.add(key);
    return async () => {
      this.externalSlots.delete(key);
      await this.schedulePump();
    };
  }
  async setAutomationStatus(taskId: string, status: AutomationStatus): Promise<void> {
    return await this.transaction(async () => {
      const task = await this.get(taskId);
      if (!task?.automationId) throw new AppError(ErrorCode.Conflict, "不是自动化任务");
      await this.tasks.put({
        ...task,
        automationStatus: status,
        status:
          status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : status === "queued"
                ? "queued"
                : status === "running"
                  ? "running"
                  : "awaiting_review",
        updatedAt: nowIso(),
      });
      if (task.currentRunId)
        await this.appendEvent({
          taskId,
          runId: task.currentRunId,
          event: { type: "automation_status", status },
        });
    });
  }
  private async writeRunResult(run: Run, result: RunOutcome): Promise<Run> {
    return await this.updateRunRow(run.id, {
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
  private async updateRunRow(
    runId: string,
    patch: Partial<{
      status: RunStatus;
      startedAt: string | null;
      endedAt: string | null;
      resultText: string | null;
      resultError: string | null;
      toolCalls: ToolCallRecord[] | null;
    }>,
  ): Promise<Run> {
    await this.persistence.runs.update(runId, patch);
    return (await this.getRun(runId))!;
  }
  /** 迁移非法时（任务已经处于其它合法终态，比如已被取消）直接跳过，不让调度流程因此中断。 */
  private async safeTransition(taskId: string, status: TaskStatus): Promise<void> {
    try {
      await this.transition(taskId, status);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.Conflict) throw error;
    }
  }
  /**
   * 构造函数末尾调用：恢复进程崩溃前的状态。
   * - status='running' 的 Run 从未被这个新实例领取过，视为中断，标 failed；
   *   若所属任务没有其它排队中的 Run，任务一并标 failed。
   * - status='queued' 的 Run 从未执行、没有任何副作用，按创建时间塞回内存队列重新调度。
   */
  private async recoverAfterRestart(): Promise<void> {
    const now = nowIso();
    const runningRows = await this.persistence.runs.byStatus("running", "local");
    for (const row of runningRows) {
      await this.persistence.runs.update(row.id, {
        status: "failed",
        resultError: "sidecar 重启，任务中断",
        endedAt: now,
      });
      const queued = (await this.persistence.runs.list(row.taskId)).some(
        (run) => run.status === "queued",
      );
      if (!queued)
        await this.tasks.update(row.taskId, (task) =>
          TASK_TRANSITIONS[task.status].includes("failed")
            ? { ...task, status: "failed", updatedAt: now }
            : task,
        );
    }
    const queuedRows = await this.persistence.runs.byStatus("queued", "local");
    for (const row of queuedRows)
      if (!(await this.persistence.isRemoteTask(row.taskId))) this.queue.push(row.id);
    if (this.queue.length)
      queueMicrotask(
        () =>
          void this.ready
            .then(async () => await this.schedulePump())
            .catch(() => {
              this.stopping = true;
              console.error("[tasks] Recovery failed; scheduling stopped");
            }),
      );
  }
  private async isRemoteTask(taskId: string) {
    return await this.persistence.isRemoteTask(taskId);
  }
  private async checkRemoteRun(run: Run): Promise<void> {
    if (!this.authorizeRemoteRun)
      throw new AppError(ErrorCode.Forbidden, "远程任务需要重新验证执行授权");
    await this.authorizeRemoteRun(run);
  }
  /** 写入一条 run_events 行并分别广播到 run 频道和 task 频道，返回的记录形状供快照 API 和 SSE 复用。 */
  async appendEvent(input: AppendEventInput): Promise<RunEventRecord> {
    return await this.transaction(async () => {
      if (input.event.type === "file_change") {
        const { change } = input.event;
        await this.recordArtifact({
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
      const record = await this.eventStore.append({
        taskId: input.taskId,
        runId: input.runId,
        parentRunId,
        event: toJsonSafe(input.event) as TaskStreamEvent,
        createdAt,
      });
      const notify = () => {
        this.hub.publish(`run:${input.runId}`, record);
        this.hub.publish(`task:${input.taskId}`, record);
      };
      const pending = this.notifications.getStore();
      if (pending) pending.push(notify);
      else notify();
      return record;
    });
  }
  async eventsAfter(input: {
    taskId?: string;
    runId?: string;
    after: number;
    limit: number;
  }): Promise<RunEventRecord[]> {
    await this.ready;
    const expired = await this.expiredHistory(input, input.after);
    if (expired) throw new AppError(ErrorCode.EventHistoryExpired, expired.message, expired);
    return await this.eventStore.read(input);
  }
  async expiredHistory(filter: EventFilter, after: number) {
    await this.ready;
    const prunedThrough = await this.eventStore.prunedThrough(filter);
    return after < prunedThrough
      ? {
          type: "history_expired" as const,
          prunedThrough,
          message: "此任务的部分运行记录已按留存策略回收，请查看任务结果与产物。",
        }
      : null;
  }
  async pinEventHistory(filter: EventFilter): Promise<() => void> {
    await this.ready;
    const taskId =
      filter.taskId ?? (filter.runId ? (await this.getRun(filter.runId))?.taskId : undefined);
    if (!taskId) throw new AppError(ErrorCode.NotFound, "任务不存在");
    if (this.historyMaintenance.has(taskId))
      throw new AppError(ErrorCode.ServiceUnavailable, "历史记录正在维护，请稍后重试");
    this.eventReaders.set(taskId, (this.eventReaders.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.eventReaders.get(taskId) ?? 1) - 1;
      if (count) this.eventReaders.set(taskId, count);
      else this.eventReaders.delete(taskId);
    };
  }
  isHistoryInUse(taskId: string): boolean {
    return this.eventReaders.has(taskId);
  }
  async withHistoryMaintenance<T>(
    taskId: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.eventReaders.has(taskId) || this.historyMaintenance.has(taskId)) return undefined;
    this.historyMaintenance.add(taskId);
    try {
      return await action();
    } finally {
      this.historyMaintenance.delete(taskId);
    }
  }
  setStorageAdmission(check: (workspace?: string) => Promise<void>): void {
    this.admission = check;
  }
  async assertStorageAvailable(workspace?: string): Promise<void> {
    await this.ready;
    await this.admission?.(workspace);
  }
  async recordArtifact(input: RecordArtifactInput): Promise<Artifact> {
    return await this.transaction(async () => {
      if (!(await this.get(input.taskId))) throw new AppError(ErrorCode.NotFound, "任务不存在");
      if (input.runId && (await this.getRun(input.runId))?.taskId !== input.taskId) {
        throw new AppError(ErrorCode.BadRequest, "成果运行不属于当前任务");
      }
      const metadata =
        input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : {};
      const key =
        input.artifactKey ??
        (typeof metadata.artifactKey === "string" ? metadata.artifactKey : undefined) ??
        this.artifactKey(input.kind, input.filePath);
      const version = await this.nextArtifactVersion(input.taskId, key);
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
        metadata: { ...metadata, artifactKey: key },
        createdAt: nowIso(),
      };
      await this.persistence.artifacts.insert({ ...row, artifactKey: key } as Artifact);
      if (input.runId)
        await this.appendEvent({
          taskId: input.taskId,
          runId: input.runId,
          parentRunId: (await this.getRun(input.runId))?.parentRunId,
          event: { type: "artifact_ready", artifactId: row.id, title: row.title },
        });
      return this.toArtifact(row);
    });
  }
  async latestArtifact(taskId: string, kind: ArtifactKind): Promise<Artifact | undefined> {
    await this.ready;
    return (await this.listArtifacts(taskId, kind)).at(-1);
  }
  async getArtifact(taskId: string, id: string): Promise<Artifact> {
    await this.ready;
    const row = await this.persistence.artifacts.get(taskId, id);
    if (!row || !(await this.get(taskId)))
      throw new AppError(ErrorCode.NotFound, "成果不存在或不属于当前任务");
    return this.toArtifact(row);
  }
  async readArtifact(taskId: string, id: string) {
    await this.ready;
    const artifact = await this.getArtifact(taskId, id);
    const run = artifact.runId ? await this.getRun(artifact.runId) : undefined;
    if (run && run.taskId !== taskId)
      throw new AppError(ErrorCode.BadRequest, "成果运行不属于当前任务");
    const generated =
      (
        artifact.metadata as {
          storage?: string;
        } | null
      )?.storage === "generated";
    return await artifactContent(artifact, generated ? this.artifactRoot : run?.input.workspace);
  }
  async reviseArtifact(taskId: string, id: string, input: ArtifactVersionInput): Promise<Artifact> {
    await this.ready;
    const view = await this.readArtifact(taskId, id);
    if (!view.editable) throw new AppError(ErrorCode.BadRequest, "该成果不支持文本编辑");
    if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
      throw new AppError(ErrorCode.BadRequest, "成果正文不能超过 2 MB");
    }
    return await this.transaction(async () => {
      const current = await this.getArtifact(taskId, id);
      const latest = (await this.listArtifacts(taskId))
        .filter((item) => item.artifactKey === current.artifactKey)
        .at(-1);
      if (
        !latest ||
        current.version !== input.baseVersion ||
        latest.version !== input.baseVersion
      ) {
        throw new AppError(ErrorCode.Conflict, "成果已更新，请切换到最新版本后再保存");
      }
      return await this.recordArtifact({
        taskId,
        runId: current.runId,
        kind: current.kind,
        title: input.title ?? current.title,
        content: input.content,
        filePath: current.filePath,
        mimeType: view.mimeType,
        artifactKey: current.artifactKey,
        metadata: {
          ...(current.metadata as Record<string, unknown> | null),
          editedBy: "user",
          baseArtifactId: current.id,
        },
      });
    });
  }
  /**
   * 占位方法：独立 Agent 审查（reviewer）产出的审查结论落库入口。M2 阶段不会有任何代码路径
   * 自动调用它——reviewer 本阶段只负责"定义存在、能被按需调用"，真正接入由后续阶段决定。
   */
  async recordReviewSummary(taskId: string, runId: string, content: string): Promise<Artifact> {
    await this.ready;
    return await this.recordArtifact({
      taskId,
      runId,
      kind: "summary",
      title: "审查摘要",
      content,
    });
  }
  async listArtifacts(taskId: string, kind?: ArtifactKind): Promise<Artifact[]> {
    await this.ready;
    return (await this.persistence.artifacts.list(taskId, kind)).map((row) => this.toArtifact(row));
  }
  private async nextArtifactVersion(taskId: string, key: string): Promise<number> {
    return (
      (await this.listArtifacts(taskId)).reduce(
        (version, item) => (item.artifactKey === key ? Math.max(version, item.version) : version),
        0,
      ) + 1
    );
  }
  private artifactKey(kind: ArtifactKind, filePath?: string | null): string {
    if (!filePath) return kind;
    const normalized = resolve(filePath);
    return `${kind}:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  }
  private toRun(row: Run): Run {
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
  private toArtifact(row: Artifact): Artifact {
    const metadata = row.metadata as Record<string, unknown> | null;
    return {
      ...row,
      kind: row.kind as ArtifactKind,
      metadata: row.metadata as Artifact["metadata"],
      artifactKey:
        typeof metadata?.artifactKey === "string"
          ? metadata.artifactKey
          : this.artifactKey(row.kind as ArtifactKind, row.filePath),
    };
  }
}

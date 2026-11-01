import type { ApprovalReason, RiskLevel } from "./contracts/approval";
import type { ToolCallRecord } from "./contracts/chat";
import type { FileChange } from "./contracts/code";
import type { AgentName } from "./contracts/provider";
import type { RunEventRecord, RunStatus, RunTrigger, Task } from "./contracts/task";

export interface ToolStep extends Pick<
  ToolCallRecord,
  "id" | "name" | "args" | "result" | "isError"
> {
  kind: "tool";
  agent: AgentName | null;
  done: boolean;
  output?: string;
  change?: FileChange;
}

export interface RouteStep {
  kind: "route";
  agent: AgentName;
  reason: string;
}

export interface ApprovalStep {
  kind: "approval";
  approvalId: string;
  title: string;
  detail: string;
  risk?: RiskLevel;
  payload?: unknown;
  reason?: ApprovalReason;
  resolved: boolean;
  approved?: boolean;
}

export interface DelegateStep {
  kind: "delegate";
  runId: string;
  agent: AgentName;
  trigger: RunTrigger;
}

/** 规则放行 / Bash 分类器自动放行留下的一行提示，不影响工具调用本身的展示。 */
export interface NoteStep {
  kind: "note";
  text: string;
  source: "rule" | "classifier";
}

export type Step = ToolStep | RouteStep | ApprovalStep | DelegateStep | NoteStep;

export interface RunNode {
  runId: string;
  parentRunId: string | null;
  agent: AgentName;
  trigger: RunTrigger;
  activeAgent: AgentName | null;
  text: string;
  steps: Step[];
  error: string | null;
  runStatus: RunStatus;
  done: boolean;
}

export interface TaskSnapshot {
  task?: Task;
  records?: RunEventRecord[];
}

export interface TaskSession {
  taskId: string | null;
  task: (Pick<Task, "status"> & Partial<Task>) | null;
  runsById: Record<string, RunNode>;
  rootOrder: string[];
  plan: { artifactId: string; version: number } | null;
  lastSeq: number;
  error: string | null;
}

export type TaskAction =
  | RunEventRecord
  | { type: "INIT_TASK"; task: Task }
  | { type: "SNAPSHOT"; taskId: string; snapshot: TaskSnapshot }
  | { type: "APPROVAL_ANSWERED"; runId: string; approvalId: string; approved: boolean }
  | { type: "ERROR"; message: string };

/**
 * Task/Run 执行树的纯状态机：把 `/tasks/:id/stream`、`/tasks/:id/events` 传回的每一条
 * `RunEventRecord`（{seq, taskId, runId, parentRunId, event, createdAt}）归约成一棵真正的
 * Run 树（父子委派关系、工具调用、审批、风险判断都结构化在 `RunNode.steps` 里）。
 * CLI（`apps/cli/src/interactive/task-reducer.ts`）和桌面端工作台共用这同一套归约逻辑。
 */

export function createInitialSession(): TaskSession {
  return {
    taskId: null,
    task: null,
    runsById: {},
    rootOrder: [],
    plan: null,
    lastSeq: 0,
    error: null,
  };
}

function emptyRunNode(
  runId: string,
  parentRunId: string | null,
  agent: AgentName,
  trigger: RunTrigger,
): RunNode {
  return {
    runId,
    parentRunId: parentRunId ?? null,
    agent,
    trigger,
    activeAgent: null,
    text: "",
    steps: [],
    error: null,
    runStatus: "running",
    done: false,
  };
}

function ensureRun(
  session: TaskSession,
  runId: string,
  parentRunId: string | null,
  agent: AgentName,
  trigger: RunTrigger,
): TaskSession {
  if (session.runsById[runId]) return session;
  const node = emptyRunNode(runId, parentRunId, agent, trigger);
  const runsById = { ...session.runsById, [runId]: node };
  const rootOrder = node.parentRunId ? session.rootOrder : [...session.rootOrder, runId];
  return { ...session, runsById, rootOrder };
}

function updateRun(
  session: TaskSession,
  runId: string,
  updater: (node: RunNode) => RunNode,
): TaskSession {
  const node = session.runsById[runId];
  if (!node) return session;
  return { ...session, runsById: { ...session.runsById, [runId]: updater(node) } };
}

function appendStep(session: TaskSession, runId: string, step: Step): TaskSession {
  return updateRun(session, runId, (node) => ({ ...node, steps: [...node.steps, step] }));
}

/** 单条 RunEventRecord 的应用逻辑；SNAPSHOT 历史回放与实时流复用同一份。 */
function applyRecord(session: TaskSession, record: RunEventRecord): TaskSession {
  const { runId, parentRunId, event } = record;
  let next = { ...session, lastSeq: Math.max(session.lastSeq, record.seq ?? 0) };
  switch (event.type) {
    case "run_started": {
      next = ensureRun(next, runId, parentRunId, event.agent, event.trigger);
      if (parentRunId) {
        next = appendStep(next, parentRunId, {
          kind: "delegate",
          runId,
          agent: event.agent,
          trigger: event.trigger,
        });
      }
      return next;
    }

    case "run_ended": {
      return updateRun(next, runId, (node) => ({
        ...node,
        runStatus: event.status,
        error: event.error ?? node.error,
        done: true,
        steps: node.steps.map((step) =>
          step.kind === "approval" && !step.resolved ? { ...step, resolved: true } : step,
        ),
      }));
    }

    case "task_status":
      return {
        ...next,
        task: next.task ? { ...next.task, status: event.status } : { status: event.status },
      };

    case "plan_updated":
      return { ...next, plan: { artifactId: event.artifactId, version: event.version } };

    case "route":
      return appendStep(next, runId, { kind: "route", agent: event.agent, reason: event.reason });

    case "agent_start":
      return updateRun(next, runId, (node) => ({
        ...node,
        activeAgent: node.activeAgent ?? event.agent,
      }));

    case "text_delta":
      return updateRun(next, runId, (node) => {
        if (node.activeAgent && event.agent !== node.activeAgent) return node;
        return { ...node, text: node.text + event.delta };
      });

    case "tool_call":
      return appendStep(next, runId, {
        kind: "tool",
        id: event.id,
        agent: event.agent,
        name: event.name,
        args: event.args,
        done: false,
      });

    case "file_change":
      return updateRun(next, runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "tool" && step.id === event.toolCallId
            ? { ...step, change: event.change }
            : step,
        ),
      }));

    case "tool_result":
      return updateRun(next, runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "tool" && step.id === event.id
            ? { ...step, result: event.result, isError: event.isError, done: true }
            : step,
        ),
      }));

    case "tool_output":
      return updateRun(next, runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "tool" && step.id === event.toolCallId
            ? { ...step, output: ((step.output ?? "") + event.delta).slice(-8000) }
            : step,
        ),
      }));

    case "auto_approved":
      return appendStep(next, runId, {
        kind: "note",
        text: `${event.name}：${event.reason}`,
        source: event.source,
      });

    case "approval_required":
      if (
        next.runsById[runId]?.steps.some(
          (step) => step.kind === "approval" && step.approvalId === event.approvalId,
        )
      )
        return next;
      if (next.task)
        next = { ...next, task: { ...next.task, pendingApprovalId: event.approvalId } };
      return appendStep(next, runId, {
        kind: "approval",
        approvalId: event.approvalId,
        title: event.title,
        detail: event.detail,
        risk: event.risk,
        payload: event.payload,
        reason: event.reason,
        resolved: false,
      });

    case "agent_end":
    case "conversation":
    case "done":
      return next;

    case "error":
      return updateRun(next, runId, (node) => ({ ...node, error: event.message }));

    default:
      return next;
  }
}

/** dispatch 的动作要么是一条 RunEventRecord（含 event/runId 字段），要么是带 type 的控制动作。 */
export function sessionReducer(session: TaskSession, action: TaskAction): TaskSession {
  if ("event" in action) {
    return applyRecord(session, action);
  }
  switch (action.type) {
    case "INIT_TASK":
      return session.task ? session : { ...session, taskId: action.task.id, task: action.task };

    case "SNAPSHOT": {
      let next: TaskSession = {
        ...session,
        taskId: action.taskId,
        task: action.snapshot.task ?? null,
      };
      for (const record of action.snapshot.records ?? []) next = applyRecord(next, record);
      // 快照的当前待审批 ID 比历史事件更权威；旧事件不包含跨端审批的最终结果。
      const task = action.snapshot.task ?? next.task;
      const pendingId = task?.pendingApprovalId;
      next = { ...next, task };
      for (const node of Object.values(next.runsById)) {
        next = updateRun(next, node.runId, (run) => ({
          ...run,
          steps: run.steps.map((step) =>
            step.kind === "approval" &&
            !step.resolved &&
            (run.done || step.approvalId !== pendingId)
              ? { ...step, resolved: true }
              : step,
          ),
        }));
      }
      return next;
    }

    case "APPROVAL_ANSWERED": {
      const next =
        session.task?.pendingApprovalId === action.approvalId
          ? { ...session, task: { ...session.task, pendingApprovalId: null } }
          : session;
      return updateRun(next, action.runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "approval" && step.approvalId === action.approvalId
            ? { ...step, resolved: true, approved: action.approved }
            : step,
        ),
      }));
    }

    case "ERROR":
      return { ...session, error: action.message };

    default:
      return session;
  }
}

export function listRootRuns(session: TaskSession): RunNode[] {
  return session.rootOrder
    .map((id) => session.runsById[id])
    .filter((node): node is RunNode => node !== undefined);
}

/** 扫描整棵 Run 树（根 Run + 委派子树），返回第一条未解决的审批步骤，供键盘 y/n 响应定位。 */
export function findPendingApproval(
  session: TaskSession,
): (ApprovalStep & { runId: string }) | null {
  for (const runId of Object.keys(session.runsById)) {
    const node = session.runsById[runId];
    if (node?.done) continue;
    const pendingId = session.task?.pendingApprovalId;
    const step = node?.steps.find(
      (candidate): candidate is ApprovalStep =>
        candidate.kind === "approval" &&
        !candidate.resolved &&
        (!pendingId || candidate.approvalId === pendingId),
    );
    if (step) return { runId, ...step };
  }
  return null;
}

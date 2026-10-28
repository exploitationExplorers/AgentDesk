/**
 * Task/Run 交互式会话的纯状态机，与 Ink 完全解耦，可直接单测。
 * 与 chat-reducer.mjs 的关键区别：`/tasks/:id/stream`、`/tasks/:id/events` 传回的每一条记录
 * 是完整的 RunEventRecord（{seq, taskId, runId, parentRunId, event, createdAt}，见
 * apps/sidecar/src/services/tasks.ts 的 RunEventRecord），而不是裸的 AgentStreamEvent——
 * 每条事件天然带着 runId/parentRunId，不需要像 chat-reducer 那样靠"当前活跃 agent"猜测归属。
 * dispatch(record) 即可；控制类动作（INIT_TASK/SNAPSHOT/APPROVAL_ANSWERED/ERROR）仍用 action.type。
 */

export function createInitialSession() {
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

function emptyRunNode(runId, parentRunId, agent, trigger) {
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

function ensureRun(session, runId, parentRunId, agent, trigger) {
  if (session.runsById[runId]) return session;
  const node = emptyRunNode(runId, parentRunId, agent, trigger);
  const runsById = { ...session.runsById, [runId]: node };
  const rootOrder = node.parentRunId ? session.rootOrder : [...session.rootOrder, runId];
  return { ...session, runsById, rootOrder };
}

function updateRun(session, runId, updater) {
  const node = session.runsById[runId];
  if (!node) return session;
  return { ...session, runsById: { ...session.runsById, [runId]: updater(node) } };
}

function appendStep(session, runId, step) {
  return updateRun(session, runId, (node) => ({ ...node, steps: [...node.steps, step] }));
}

/** 单条 RunEventRecord 的应用逻辑；SNAPSHOT 历史回放与实时流复用同一份。 */
function applyRecord(session, record) {
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

    case "tool_result":
      return updateRun(next, runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "tool" && step.id === event.id
            ? { ...step, result: event.result, isError: event.isError, done: true }
            : step,
        ),
      }));

    case "approval_required":
      return appendStep(next, runId, {
        kind: "approval",
        approvalId: event.approvalId,
        title: event.title,
        detail: event.detail,
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
export function sessionReducer(session, action) {
  if (action && typeof action === "object" && "event" in action && "runId" in action) {
    return applyRecord(session, action);
  }
  switch (action.type) {
    case "INIT_TASK":
      return session.task ? session : { ...session, taskId: action.task.id, task: action.task };

    case "SNAPSHOT": {
      let next = { ...session, taskId: action.taskId, task: action.snapshot.task ?? null };
      for (const record of action.snapshot.records ?? []) next = applyRecord(next, record);
      return next;
    }

    case "APPROVAL_ANSWERED":
      return updateRun(session, action.runId, (node) => ({
        ...node,
        steps: node.steps.map((step) =>
          step.kind === "approval" && step.approvalId === action.approvalId
            ? { ...step, resolved: true, approved: action.approved }
            : step,
        ),
      }));

    case "ERROR":
      return { ...session, error: action.message };

    default:
      return session;
  }
}

export function listRootRuns(session) {
  return session.rootOrder.map((id) => session.runsById[id]).filter(Boolean);
}

/** 扫描整棵 Run 树（根 Run + 委派子树），返回第一条未解决的审批步骤，供键盘 y/n 响应定位。 */
export function findPendingApproval(session) {
  for (const runId of Object.keys(session.runsById)) {
    const node = session.runsById[runId];
    const step = node.steps.find(
      (candidate) => candidate.kind === "approval" && !candidate.resolved,
    );
    if (step) return { runId, ...step };
  }
  return null;
}

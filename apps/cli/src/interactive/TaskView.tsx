import { useEffect, useReducer, useRef, useState } from "react";
import type { RunEventRecord, Task } from "@agentdesk/shared";
import { Box, Static, Text, useApp, useInput } from "ink";
import {
  apiRequest as defaultApiRequest,
  consumeSse as defaultConsumeSse,
  type ApiState,
} from "../client.js";
import {
  createInitialSession,
  findPendingApproval,
  listRootRuns,
  sessionReducer,
  type TaskSnapshot,
} from "./task-reducer.js";
import RunView from "./RunView.js";
import TaskStatusBar from "./TaskStatusBar.js";
import type { AccessibilityTheme } from "./theme.js";
import { useApprovalWaiter } from "./useApprovalWaiter.js";

export interface TaskViewProps {
  state: ApiState;
  task: Task;
  snapshot?: TaskSnapshot;
  afterSeq?: number;
  theme: AccessibilityTheme;
  apiRequest?: typeof defaultApiRequest;
  consumeSse?: (
    body: ReadableStream<Uint8Array>,
    onEvent: (record: RunEventRecord) => void | Promise<void>,
  ) => Promise<void>;
}

function initTaskSession({ task, snapshot }: Pick<TaskViewProps, "task" | "snapshot">) {
  const base = createInitialSession();
  if (!snapshot) return { ...base, taskId: task.id, task };
  return sessionReducer(base, { type: "SNAPSHOT", taskId: task.id, snapshot });
}

/**
 * Task 命令的根 Ink 组件：不是常驻会话，到 SSE 流自然结束（根 Run 结束或连接断开）或用户按
 * Ctrl+C 时整个命令退出。Ctrl+C 只断开本地连接，刻意不调用 /tasks/:id/cancel——关闭页面/
 * 断开连接不应意外取消后端正在执行的任务（开发任务.md 的全局原则），显式取消只通过
 * `agentdesk cancel <taskId>` 完成。
 */
export default function TaskView({
  state,
  task,
  snapshot,
  afterSeq = 0,
  theme,
  apiRequest = defaultApiRequest,
  consumeSse = defaultConsumeSse,
}: TaskViewProps) {
  const { exit } = useApp();
  const [session, dispatch] = useReducer(sessionReducer, { task, snapshot }, initTaskSession);
  const [expanded, setExpanded] = useState(false);
  const [ended, setEnded] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const { waitForApproval, answerLocally } = useApprovalWaiter(state, apiRequest);
  const initialSessionRef = useRef(session);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const resolvedApprovals = new Map<string, boolean>();
    const resolveApproval = async (runId: string, approvalId: string) => {
      if (!resolvedApprovals.has(approvalId)) {
        const decision = await waitForApproval(approvalId, controller.signal);
        if (!decision || !active || controller.signal.aborted) return;
        if (decision.source === "local") {
          await apiRequest(state, `/approvals/${encodeURIComponent(approvalId)}`, {
            method: "POST",
            body: JSON.stringify({ approved: decision.approved }),
            signal: controller.signal,
          });
        }
        resolvedApprovals.set(approvalId, decision.approved);
      }
      const approved = resolvedApprovals.get(approvalId);
      if (approved !== undefined) {
        dispatch({ type: "APPROVAL_ANSWERED", runId, approvalId, approved });
      }
    };
    (async () => {
      try {
        // inspect 的快照已包含审批事件；续流从 afterSeq 开始，不会再次发出该事件。
        // 只恢复服务端标记的当前审批，避免把历史中已完成的审批重新弹给用户。
        const initial = initialSessionRef.current;
        const pendingId = initial.task?.pendingApprovalId;
        if (pendingId) {
          const owner = Object.values(initial.runsById).find(
            (run) =>
              !run.done &&
              run.steps.some(
                (step) =>
                  step.kind === "approval" && !step.resolved && step.approvalId === pendingId,
              ),
          );
          if (owner) await resolveApproval(owner.runId, pendingId);
        }
        if (!active || controller.signal.aborted) return;
        const response = await apiRequest(
          state,
          `/tasks/${encodeURIComponent(task.id)}/stream?after=${afterSeq}`,
          { signal: controller.signal },
        );
        if (!response.body) throw new Error("服务未返回事件流。");
        await consumeSse(response.body, async (record) => {
          if (!active || controller.signal.aborted) return;
          dispatch(record);
          if (record.event.type === "approval_required") {
            await resolveApproval(record.runId, record.event.approvalId);
          }
        });
      } catch (error) {
        if (!controller.signal.aborted && active)
          dispatch({
            type: "ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (active) setEnded(true);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [state, task.id, afterSeq, apiRequest, consumeSse, waitForApproval]);

  useEffect(() => {
    if (ended) exit();
  }, [ended, exit]);

  useInput((character, key) => {
    if (key.ctrl && character === "c") {
      controllerRef.current?.abort();
      exit();
      return;
    }
    const pending = findPendingApproval(session);
    if (pending) {
      if (/^y$/i.test(character)) answerLocally(true);
      else if (/^n$/i.test(character) || key.escape) answerLocally(false);
      return;
    }
    if (key.ctrl && character === "o") setExpanded((value) => !value);
  });

  const roots = listRootRuns(session);
  const latestRoot = roots.at(-1);
  const liveRoot = latestRoot && !latestRoot.done ? latestRoot : null;
  const finishedRoots = liveRoot ? roots.slice(0, -1) : roots;

  return (
    <Box flexDirection="column">
      <Static items={finishedRoots}>
        {(run) => (
          <RunView
            key={run.runId}
            run={run}
            runsById={session.runsById}
            expanded={expanded}
            theme={theme}
          />
        )}
      </Static>
      {liveRoot ? (
        <RunView
          run={liveRoot}
          runsById={session.runsById}
          expanded={expanded}
          theme={theme}
          live
        />
      ) : null}
      {session.error ? <Text color="red">{session.error}</Text> : null}
      <TaskStatusBar taskId={session.taskId} status={session.task?.status} busy={!ended} />
    </Box>
  );
}

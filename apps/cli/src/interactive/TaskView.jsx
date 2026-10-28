import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { apiRequest as defaultApiRequest, consumeSse as defaultConsumeSse } from "../client.mjs";
import {
  createInitialSession,
  findPendingApproval,
  listRootRuns,
  sessionReducer,
} from "./task-reducer.mjs";
import RunView from "./RunView.jsx";
import TaskStatusBar from "./TaskStatusBar.jsx";

function initTaskSession({ task, snapshot }) {
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
}) {
  const { exit } = useApp();
  const [session, dispatch] = useReducer(sessionReducer, { task, snapshot }, initTaskSession);
  const [expanded, setExpanded] = useState(false);
  const [ended, setEnded] = useState(false);
  const controllerRef = useRef(null);
  const approvalResolveRef = useRef(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    (async () => {
      try {
        const response = await apiRequest(
          state,
          `/tasks/${encodeURIComponent(task.id)}/stream?after=${afterSeq}`,
          { signal: controller.signal },
        );
        if (!response.body) throw new Error("服务未返回事件流。");
        await consumeSse(response.body, async (record) => {
          if (!active) return;
          dispatch(record);
          if (record.event.type === "approval_required") {
            const approved = await new Promise((resolve) => {
              approvalResolveRef.current = resolve;
            });
            approvalResolveRef.current = null;
            dispatch({
              type: "APPROVAL_ANSWERED",
              runId: record.runId,
              approvalId: record.event.approvalId,
              approved,
            });
            await apiRequest(state, `/approvals/${encodeURIComponent(record.event.approvalId)}`, {
              method: "POST",
              body: JSON.stringify({ approved }),
            });
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
    // 只在挂载时建立一次连接：Task 命令是一次性视图，不像 chat 那样反复提交新一轮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ended) exit();
  }, [ended, exit]);

  useInput((character, key) => {
    const pending = findPendingApproval(session);
    if (pending) {
      if (/^y$/i.test(character)) approvalResolveRef.current?.(true);
      else if (/^n$/i.test(character) || key.escape) approvalResolveRef.current?.(false);
      return;
    }
    if (key.ctrl && character === "c") {
      controllerRef.current?.abort();
      exit();
      return;
    }
    if (character === "o") setExpanded((value) => !value);
  });

  const roots = listRootRuns(session);
  const liveRoot = roots.length && !roots.at(-1).done ? roots.at(-1) : null;
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

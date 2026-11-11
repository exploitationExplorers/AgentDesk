import { useEffect, useState } from "react";
import type { RunEventRecord, Task } from "@agentdesk/shared";
import { subscribe } from "../../lib/http";
import { codeApi, type CodeSource } from "./api";
import { createTaskEventBuffer, type TaskEventSnapshot } from "./task-event-buffer";

const emptySnapshot = createTaskEventBuffer({ taskId: "", onPublish: () => {} }).getSnapshot();

/** 真 SSE 推送；断线由 EventSource 原生重连接管，服务端按 Last-Event-ID 续传游标。 */
export function useTaskEvents(
  source: CodeSource,
  task: Pick<Task, "id" | "currentRunId" | "automationId">,
) {
  const { id: taskId, currentRunId, automationId } = task;
  const continuous = Boolean(automationId);
  const [state, setState] = useState<
    TaskEventSnapshot & {
      key: string;
      error: string | null;
      historyExpired: boolean;
    }
  >({ key: "", ...emptySnapshot, error: null, historyExpired: false });
  const key = JSON.stringify([source, taskId, currentRunId, continuous]);
  useEffect(() => {
    if (!taskId) return;
    const buffer = createTaskEventBuffer({
      taskId,
      onPublish: (snapshot) => setState({ key, ...snapshot, error: null, historyExpired: false }),
    });
    const unsubscribe = subscribe<RunEventRecord>(
      codeApi(source).streamPath(taskId),
      buffer.append,
      {
        query: { after: "0" },
        onHistoryExpired: (message) =>
          setState({ key, ...buffer.getSnapshot(), error: message, historyExpired: true }),
        // 历史根运行结束不能中断本轮回放；自动化任务与服务端保持持续订阅。
        isFinal: (record) =>
          !continuous &&
          record.event.type === "run_ended" &&
          record.parentRunId === null &&
          record.runId === currentRunId,
      },
    );
    return () => {
      buffer.dispose();
      unsubscribe();
    };
  }, [source, taskId, key, currentRunId, continuous]);
  return state.key === key ? state : { ...emptySnapshot, error: null, historyExpired: false };
}

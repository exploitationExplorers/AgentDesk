import { useEffect, useState } from "react";
import type { RunEventRecord, Task } from "@agentdesk/shared";
import { subscribe } from "../../lib/http";
import { codeApi, type CodeSource } from "./api";

/** 真 SSE 推送；断线由 EventSource 原生重连接管，服务端按 Last-Event-ID 续传游标。 */
export function useTaskEvents(
  source: CodeSource,
  task: Pick<Task, "id" | "currentRunId" | "automationId">,
) {
  const { id: taskId, currentRunId, automationId } = task;
  const continuous = Boolean(automationId);
  const [state, setState] = useState<{
    key: string;
    records: RunEventRecord[];
    error: string | null;
  }>({ key: "", records: [], error: null });
  const key = `${source}:${taskId ?? ""}`;
  useEffect(() => {
    if (!taskId) return;
    let records: RunEventRecord[] = [];
    let lastSeq = 0;
    const unsubscribe = subscribe<RunEventRecord>(
      codeApi(source).streamPath(taskId),
      (record) => {
        if (record.seq <= lastSeq) return;
        lastSeq = record.seq;
        records = [...records, record];
        setState({ key, records, error: null });
      },
      {
        query: { after: "0" },
        // 历史根运行结束不能中断本轮回放；自动化任务与服务端保持持续订阅。
        isFinal: (record) =>
          !continuous &&
          record.event.type === "run_ended" &&
          record.parentRunId === null &&
          record.runId === currentRunId,
      },
    );
    return unsubscribe;
  }, [source, taskId, key, currentRunId, continuous]);
  return state.key === key ? state : { records: [], error: null };
}

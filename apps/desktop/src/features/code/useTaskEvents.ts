import { useEffect, useState } from "react";
import type { RunEventRecord } from "@agentdesk/shared";
import { codeApi, type CodeSource } from "./api";

/** 按持久化游标增量读取，跨运行、断线和 CLI 代理使用同一条回放链路。 */
export function useTaskEvents(source: CodeSource, taskId?: string) {
  const [state, setState] = useState<{
    key: string;
    records: RunEventRecord[];
    error: string | null;
  }>({ key: "", records: [], error: null });
  const key = `${source}:${taskId ?? ""}`;
  useEffect(() => {
    if (!taskId) return;
    let active = true;
    let after = 0;
    let records: RunEventRecord[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        let page: RunEventRecord[];
        do {
          page = await codeApi(source).events(taskId, after);
          if (!active) return;
          const fresh = page.filter((record) => record.seq > after);
          if (!fresh.length) break;
          records = [...records, ...fresh];
          after = fresh.at(-1)!.seq;
        } while (page.length === 500 && active);
        if (active) setState({ key, records, error: null });
      } catch (error) {
        if (active)
          setState({ key, records, error: error instanceof Error ? error.message : "同步失败" });
      } finally {
        if (active) timer = setTimeout(() => void poll(), 800);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [source, taskId, key]);
  return state.key === key ? state : { records: [], error: null };
}

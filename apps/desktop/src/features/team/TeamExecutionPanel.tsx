import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { TeamExecutionPage, type TeamTask, type TeamExecutionEntry } from "@agentdesk/shared";
import { teamRequest } from "./team-api";

const labels: Record<TeamExecutionEntry["kind"], string> = {
  stage: "阶段",
  message: "Agent",
  command: "工具调用",
  output: "输出",
  files: "文件变更",
  check: "检查",
  notice: "提示",
};
export function TeamExecutionPanel({
  task,
  token,
  online,
}: {
  task: TeamTask;
  token: string;
  online: boolean;
}) {
  const [open, setOpen] = useState(task.status === "running" || !!task.executionRequestedAt);
  const [follow, setFollow] = useState(true);
  const saved = useRef<{ entries: TeamExecutionEntry[]; cursor: number; truncated: boolean }>({
    entries: [],
    cursor: 0,
    truncated: false,
  });
  const list = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["team-execution", task.id, token],
    enabled: open,
    refetchInterval: open ? 2000 : false,
    queryFn: async () => {
      let current = saved.current;
      for (let page = 0; page < 3; page++) {
        const response = TeamExecutionPage.parse(
          await teamRequest(`/tasks/${task.id}/events?after=${current.cursor}`, token),
        );
        const entries = [
          ...current.entries,
          ...response.entries.filter(
            (entry) => !current.entries.some((old) => old.seq === entry.seq),
          ),
        ];
        current = {
          entries: entries.slice(-240),
          cursor: response.cursor,
          truncated: current.truncated || response.truncated || entries.length > 240,
        };
        saved.current = current;
        if (response.entries.length < 100) break;
      }
      return current;
    },
  });
  const entries = useMemo(() => query.data?.entries ?? [], [query.data?.entries]);
  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [entries, follow, open]);
  const waiting = task.status === "queued" && !!task.executionRequestedAt;
  return (
    <section className="team-live" aria-label={`执行过程：${task.title}`}>
      <button
        className="team-live-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          <span
            className={`team-live-dot ${task.status === "running" && online ? "is-live" : ""}`}
          />
          <b>执行过程</b>
        </span>
        <span>
          {task.status === "running"
            ? online
              ? "本机在线 · 每 2 秒更新"
              : "本机心跳中断"
            : waiting
              ? "等待本机接单"
              : "查看记录"}{" "}
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <>
          <div className="team-live-toolbar">
            <span>由成员本机上报 · 第 {task.attempt} 次执行</span>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              跟随最新
            </label>
          </div>
          {query.error ? (
            <p role="alert">
              执行记录读取失败，请检查连接。
              <button onClick={() => void query.refetch()}>重试</button>
            </p>
          ) : null}
          <div
            className="team-live-log"
            ref={list}
            role="log"
            aria-live="off"
            aria-label={`任务执行记录：${task.title}`}
          >
            {query.data?.truncated ? (
              <p className="team-muted">仅保留最近 240 条记录，更早内容已省略。</p>
            ) : null}
            {!entries.length ? (
              <p className="team-live-empty">
                {query.isPending
                  ? "正在读取执行记录…"
                  : waiting
                    ? online
                      ? "已领取，等待本机执行器接单。"
                      : "已领取，本机执行器尚未上线。请在自己的终端启动 work，再确认执行。"
                    : task.status === "running"
                      ? "等待本机上报。旧版客户端请升级；详细共享需开启 shareExecution。"
                      : "暂无执行记录。启动新版本机执行器后，阶段与已授权的详细输出会显示在这里。"}
              </p>
            ) : null}
            {entries.map((entry) => (
              <article className={`team-live-entry kind-${entry.kind}`} key={entry.seq}>
                <div>
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
                  </time>
                  <span>
                    {labels[entry.kind]} · 第 {entry.attempt} 次
                  </span>
                </div>
                <pre>{entry.text}</pre>
              </article>
            ))}
          </div>
          <p className="team-live-footnote">
            工具审批与执行确认在成员本机终端处理。详细共享需在 runner.json 开启
            shareExecution；日志会过滤常见凭据格式，仍请勿输出秘密。
          </p>
        </>
      ) : null}
    </section>
  );
}

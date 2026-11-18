import { useMemo, useRef, useState } from "react";
import type { TeamExecutionEntry, TeamTask } from "@agentdesk/shared";
import {
  RunningLightBorder,
  useExecutionLights,
} from "../../components/execution-light/ExecutionLight";

/** 光线仅由新增的本机上报驱动，历史重载与任务等待不产生飞行。 */
export function TeamExecutionFlow({
  task,
  entries,
  online,
}: {
  task: TeamTask;
  entries: TeamExecutionEntry[];
  online: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const current = useMemo(
    () => entries.filter((entry) => entry.attempt === task.attempt),
    [entries, task.attempt],
  );
  const events = useMemo(
    () =>
      current.map((entry) => ({
        id: `${task.id}:${entry.seq}`,
        from: ["files", "check"].includes(entry.kind) ? "task" : "agent",
        to: ["files", "check"].includes(entry.kind) ? "delivery" : "task",
        color: entry.kind === "check" ? "#6c9d85" : "#9b87c8",
      })),
    [current, task.id],
  );
  useExecutionLights(host, events, paused);
  const running = task.status === "running" && online;
  return (
    <div className="team-flow" ref={host} aria-label="本机执行流向">
      <div className="team-flow-heading">
        <span>本机执行流向</span>
        <button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused}>
          {paused ? "继续光线" : "暂停光线"}
        </button>
      </div>
      <div className="team-flow-nodes">
        <div className="team-flow-node" data-light-anchor="agent">
          <span>01</span>
          <strong>成员本机</strong>
          <small>{online ? "执行器在线" : "等待连接"}</small>
        </div>
        <span className="team-flow-link" aria-hidden="true" />
        <div className="team-flow-node" data-light-anchor="task">
          <RunningLightBorder active={running} color="#9b87c8" />
          <span>02</span>
          <strong>当前任务</strong>
          <small>
            {running ? "正在执行" : "执行记录"} · 第 {task.attempt} 次
          </small>
        </div>
        <span className="team-flow-link" aria-hidden="true" />
        <div className="team-flow-node" data-light-anchor="delivery">
          <span>03</span>
          <strong>文件与检查</strong>
          <small>
            {current.filter((entry) => entry.kind === "files" || entry.kind === "check").length}{" "}
            条上报
          </small>
        </div>
      </div>
    </div>
  );
}

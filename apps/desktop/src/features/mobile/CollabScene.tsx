import { ArrowRight } from "lucide-react";
import type { Task } from "@agentdesk/shared";
import { displayTime } from "./hooks";

export function CollabScene({
  tasks,
  onOpenTask,
}: {
  tasks: Task[];
  onOpenTask: (id: string) => void;
}) {
  const active = tasks.find((task) => ["queued", "planning", "running"].includes(task.status));
  const awaiting = tasks.find((task) => task.status.startsWith("awaiting_"));
  const live = Boolean(active || awaiting);
  const focus = active ?? awaiting ?? tasks[0];
  const agents = live ? 3 : 0;
  const status = live ? `${agents} 个 Agent 协作中` : focus ? "最近一次协作已结束" : "等待任务";
  const activity = active
    ? `${active.agent ?? "Agent"} 正在推进「${active.title || "未命名任务"}」`
    : awaiting
      ? `等待你确认：「${awaiting.title || "未命名任务"}」`
      : focus
        ? `最近任务：${focus.title || "未命名任务"}`
        : "创建任务后，在这里查看协作过程";

  return (
    <section className="m-section m-collab-section">
      <div className="m-section-head">
        <h2>协作现场</h2>
        <span className="m-demo-chip">{live ? "LIVE" : "STANDBY"}</span>
      </div>
      <div className={`m-collab-panel${live ? "" : " is-standby"}`}>
        <div className="m-collab-header">
          <strong>{focus?.title || "暂无进行中的协作"}</strong>
          <span className="m-live-label">
            <i className="m-dot" />
            {status}
          </span>
        </div>
        <div className="m-topology" aria-label="协作流程：主 Agent 分配给编码和审查 Agent">
          <svg
            className="m-wires"
            viewBox="0 0 320 168"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className="m-wire-base"
              d="M113 83 C155 83 153 40 206 40 M113 83 C155 83 153 130 206 130"
            />
            {live && (
              <>
                <path className="m-wire-lit" d="M113 83 C155 83 153 40 206 40" />
                <path className="m-wire-amber" d="M113 83 C155 83 153 130 206 130" />
              </>
            )}
            <circle cx="142" cy="83" r="3" stroke="#6195bd" fill="#14283f" />
          </svg>
          <div className="m-node m-node-manager">
            <span className="m-node-icon">A</span>
            <span>
              <strong>主 Agent</strong>
              <small>规划 · 分配任务</small>
            </span>
          </div>
          <div className="m-node m-node-coder">
            <span className="m-node-icon">C</span>
            <span>
              <strong>编码 Agent</strong>
              <small>{active ? "执行中" : "待命"}</small>
            </span>
          </div>
          <div className="m-node m-node-reviewer">
            <span className="m-node-icon">R</span>
            <span>
              <strong>审查 Agent</strong>
              <small>{awaiting ? "待确认" : "待命"}</small>
            </span>
          </div>
        </div>
        <div className="m-graph-footer">
          <span>
            <i />
            {live ? "任务流转" : "待机"}
          </span>
          <span>
            {live
              ? `${tasks.filter((task) => ["queued", "planning", "running"].includes(task.status)).length} 个执行中 · ${tasks.filter((task) => task.status.startsWith("awaiting_")).length} 项待确认`
              : "暂无执行中的协作任务"}
          </span>
          <span>{focus ? displayTime(focus.updatedAt) : "—"}</span>
        </div>
        <button
          type="button"
          className="m-activity-line"
          disabled={!focus}
          onClick={() => focus && onOpenTask(focus.id)}
        >
          <time>{focus ? displayTime(focus.updatedAt) : "--:--"}</time>
          <strong>{activity}</strong>
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

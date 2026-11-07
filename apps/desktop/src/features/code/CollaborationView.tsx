import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Check,
  ChevronRight,
  FileCode2,
  FolderOpen,
  GitBranch,
  Pause,
  Play,
  Radio,
  ShieldAlert,
  Timer,
} from "lucide-react";
import type { Approval, Run, RunEventRecord, Task, TaskSession } from "@agentdesk/shared";
import { Button, Dialog, cn } from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";
import type { CodeSource } from "./api";
import { artifactsApi } from "./artifacts-api";
import {
  buildCollaborationModel,
  COLLABORATION_STATUS,
  formatRunDuration,
  isRunActive,
  type CollaborationRun,
  type CollaborationStatus,
} from "./collaboration-model";
import { CollaborationWires, type CollaborationWire } from "./CollaborationWires";
import "./collaboration.css";

const EMPTY_ARTIFACTS: never[] = [];
const COLORS = [
  "var(--collab-sky)",
  "var(--ad-brand)",
  "var(--collab-mint)",
  "var(--collab-amber)",
];
const colorStyle = (color: string): CSSProperties => ({ "--collab-color": color }) as CSSProperties;
const clock = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });

function Status({ value }: { value: CollaborationStatus }) {
  return (
    <span className={`ad-collab-status is-${value}`}>
      {value === "succeeded" ? (
        <Check size={11} />
      ) : value === "waiting" ? (
        <ShieldAlert size={11} />
      ) : null}
      {COLLABORATION_STATUS[value]}
    </span>
  );
}

function eventLabel(record: RunEventRecord) {
  const event = record.event;
  switch (event.type) {
    case "run_started":
      return event.parentRunId ? "开始委派任务" : "开始本轮执行";
    case "run_ended":
      return `执行${event.status === "succeeded" ? "完成" : event.status === "cancelled" ? "已停止" : "失败"}`;
    case "tool_call":
      return TOOL_LABELS[event.name] ?? event.name;
    case "approval_required":
      return `等待确认：${event.title}`;
    case "artifact_ready":
      return `产物就绪：${event.title}`;
    case "error":
      return event.message;
    default:
      return "状态已更新";
  }
}

export function CollaborationView({
  task,
  source,
  runs,
  session,
  records,
  approvals,
  onInspectRun,
  onInspectChange,
  onOpenArtifacts,
}: {
  task: Task;
  source: CodeSource;
  runs: Run[];
  session: TaskSession;
  records: RunEventRecord[];
  approvals: Approval[];
  onInspectRun: (runId: string) => void;
  onInspectChange: (path: string, runId: string) => void;
  onOpenArtifacts: () => void;
}) {
  const [rootId, setRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [now, setNow] = useState(Date.now);
  const host = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const artifacts = useQuery({
    queryKey: ["artifacts", source, task.id],
    queryFn: () => artifactsApi(source).list(task.id),
    refetchInterval: 5000,
  });
  const pendingIds = useMemo(() => new Set(approvals.map((approval) => approval.id)), [approvals]);
  const model = useMemo(
    () =>
      buildCollaborationModel({
        task,
        runs,
        session,
        records,
        artifacts: artifacts.data ?? EMPTY_ARTIFACTS,
        pendingApprovalIds: pendingIds,
        rootId,
      }),
    [task, runs, session, records, artifacts.data, pendingIds, rootId],
  );
  const selected = model.nodes.find((run) => run.id === selectedId);
  const colors = useMemo(
    () =>
      new Map(
        model.nodes.map((run, index) => [
          run.id,
          run.id === model.root?.id
            ? "var(--ad-brand)"
            : (COLORS[(index - 1 + COLORS.length) % COLORS.length] ?? "var(--ad-brand)"),
        ]),
      ),
    [model.nodes, model.root?.id],
  );
  const wires = useMemo<CollaborationWire[]>(
    () => [
      ...model.members.map((run) => ({
        id: run.id,
        from: `member-out:${run.id}`,
        to: run.parentId === model.root?.id ? `hub:${run.id}` : `member-in:${run.parentId}`,
        color: colors.get(run.id) ?? "var(--ad-brand)",
        live: run.status === "running",
      })),
      ...(["outputs", "events"] as const).map((target, index) => ({
        id: target,
        from: `hub-out:${target}`,
        to: target,
        color: index ? "var(--collab-mint)" : "var(--collab-sky)",
        live:
          model.root?.status === "running" &&
          (index ? model.events.length > 0 : model.outputs.length > 0),
      })),
    ],
    [model.members, model.root, model.events.length, model.outputs.length, colors],
  );

  useEffect(() => {
    let inView = true;
    const sync = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      sync();
    });
    if (host.current) observer.observe(host.current);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  useEffect(() => {
    if (!model.live || !visible) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [model.live, visible]);

  const end = model.live ? Math.max(now, model.endedAt) : model.endedAt;
  const duration = Math.max(1000, end - model.startedAt);
  const percentage = (value: number) =>
    Math.min(100, Math.max(0, ((value - model.startedAt) / duration) * 100));
  const progress = model.members.length
    ? Math.round((model.completed / model.members.length) * 100)
    : model.root?.status === "succeeded"
      ? 100
      : 0;
  const openRun = (run: CollaborationRun) => setSelectedId(run.id);

  return (
    <div
      ref={host}
      className={cn("ad-collab", (paused || !visible) && "is-motion-paused")}
      data-testid="collaboration-view"
    >
      <div className="ad-collab-heading">
        <div>
          <p className="ad-collab-eyebrow">AGENT COLLABORATION</p>
          <h2>
            看见协作的每一步<span>.</span>
          </h2>
          <p>从任务派发到成果交付，让每一条执行路径清晰可见。</p>
        </div>
        <div className="ad-collab-controls">
          {model.roots.length > 1 ? (
            <label className="ad-collab-round">
              执行轮次
              <select
                aria-label="执行轮次"
                value={model.root?.id ?? ""}
                onChange={(event) => {
                  setRootId(event.target.value);
                  setSelectedId(null);
                }}
              >
                {model.roots.map((run, index) => (
                  <option key={run.id} value={run.id}>
                    第 {index + 1} 轮 · {clock(run.startedAt)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPaused((value) => !value)}
            aria-pressed={paused}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            <span className="ml-1.5">{paused ? "继续动效" : "暂停动效"}</span>
          </Button>
        </div>
      </div>
      <section className="ad-collab-workspace" aria-label="Agent 协作图">
        <div className="ad-collab-workspace-top">
          <div className="ad-collab-run-title">
            <Radio size={13} />
            <strong title={task.title}>{task.title}</strong>
          </div>
          <div className="ad-collab-metrics">
            <span>
              <b>{model.members.filter((run) => run.status === "running").length}</b> 成员执行中
            </span>
            <span>
              <b>{model.completed}</b> / {model.members.length} 完成
            </span>
            <span className="ad-collab-elapsed">
              <Timer size={12} />
              {formatRunDuration(end - model.startedAt)}
            </span>
          </div>
        </div>
        {!model.root ? (
          <div className="ad-collab-empty">
            <Bot size={26} />
            <h3>等待执行记录</h3>
            <p>任务开始后，成员、运行状态和成果会自动显示在这里。</p>
          </div>
        ) : (
          <>
            <div className="ad-collab-board" ref={board}>
              <CollaborationWires host={board} wires={wires} />
              <section className="ad-collab-column">
                <h3>
                  <span>01</span>执行成员<small>{model.members.length} RUNS</small>
                </h3>
                <div className="ad-collab-members">
                  {model.members.map((run, index) => {
                    const Icon = AGENT_META[run.agent].icon;
                    const parent = model.nodes.find((node) => node.id === run.parentId);
                    return (
                      <button
                        type="button"
                        className="ad-collab-member"
                        key={run.id}
                        onClick={() => openRun(run)}
                        style={colorStyle(colors.get(run.id) ?? "var(--ad-brand)")}
                        data-collab-node
                        data-testid="collaboration-member"
                        aria-label={`查看${AGENT_META[run.agent].label}的任务详情`}
                      >
                        <span className="ad-collab-member-top">
                          <span className="ad-collab-avatar">
                            <Icon size={16} />
                          </span>
                          <strong>{AGENT_META[run.agent].label}</strong>
                          <Status value={run.status} />
                        </span>
                        <span className="ad-collab-member-title">
                          <small>T{String(index + 1).padStart(2, "0")}</small>
                          <span title={run.title}>{run.title}</span>
                        </span>
                        {run.parentId !== model.root?.id && parent ? (
                          <span className="ad-collab-parent">
                            由{AGENT_META[parent.agent].label}委派
                          </span>
                        ) : null}
                        <i
                          className="ad-collab-port is-right"
                          data-collab-port={`member-out:${run.id}`}
                        />
                        <i
                          className="ad-collab-port is-left"
                          data-collab-port={`member-in:${run.id}`}
                        />
                      </button>
                    );
                  })}
                  {!model.members.length ? (
                    <div className="ad-collab-no-members">
                      <GitBranch size={22} />
                      <p>本轮由主控直接执行</p>
                      <small>委派给其他 Agent 后，成员会出现在这里。</small>
                    </div>
                  ) : null}
                </div>
              </section>
              <section className="ad-collab-column">
                <h3>
                  <span>02</span>主控编排<small>ORCHESTRATOR</small>
                </h3>
                <article className="ad-collab-hub" data-collab-node>
                  <button
                    className="ad-collab-hub-title"
                    type="button"
                    onClick={() => model.root && openRun(model.root)}
                    aria-label="查看主控任务详情"
                  >
                    <span className="ad-collab-hub-avatar">
                      <Bot size={23} />
                    </span>
                    <span>
                      <strong>
                        {model.root.agent === "orchestrator"
                          ? "AgentDesk"
                          : `${AGENT_META[model.root.agent].label}助手`}
                      </strong>
                      <small>拆解任务 · 协调执行 · 汇总结果</small>
                    </span>
                    <Status value={model.root.status} />
                  </button>
                  <div className="ad-collab-goal">
                    <span>当前目标</span>
                    <p title={model.root.title}>{model.root.title}</p>
                  </div>
                  {model.members.map((run) => (
                    <button
                      type="button"
                      className="ad-collab-hub-row"
                      style={colorStyle(colors.get(run.id) ?? "var(--ad-brand)")}
                      key={run.id}
                      onClick={() => openRun(run)}
                    >
                      <i className="ad-collab-port is-left" data-collab-port={`hub:${run.id}`} />
                      <i className="ad-collab-mini-dot" />
                      <span title={run.title}>{run.title}</span>
                      <Status value={run.status} />
                    </button>
                  ))}
                  {!model.members.length ? (
                    <p className="ad-collab-current-tool">
                      {model.root.currentTool
                        ? (TOOL_LABELS[model.root.currentTool] ?? model.root.currentTool)
                        : COLLABORATION_STATUS[model.root.status]}{" "}
                      · {model.root.toolCount} 次工具调用
                    </p>
                  ) : null}
                  <div className="ad-collab-hub-progress">
                    <span>{model.members.length ? "成员任务完成" : "本轮状态"}</span>
                    <b>
                      {model.members.length
                        ? `${progress}%`
                        : COLLABORATION_STATUS[model.root.status]}
                    </b>
                    <div
                      role="progressbar"
                      aria-label="成员任务完成比例"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <i style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  <i
                    className="ad-collab-port is-right ad-collab-output-port"
                    data-collab-port="hub-out:outputs"
                  />
                  <i
                    className="ad-collab-port is-right ad-collab-events-port"
                    data-collab-port="hub-out:events"
                  />
                </article>
                <p className="ad-collab-hub-note">每一份结果，都回到同一条主线</p>
              </section>
              <section className="ad-collab-column ad-collab-deliverables">
                <h3>
                  <span>03</span>成果交付<small>OUTPUT</small>
                </h3>
                <article className="ad-collab-output" data-collab-node>
                  <div className="ad-collab-output-heading">
                    <FolderOpen size={19} />
                    <div>
                      <h4>工作区产物</h4>
                      <p>本轮文件变更与交付成果</p>
                    </div>
                    <b>{model.outputs.length}</b>
                    <i className="ad-collab-port is-left" data-collab-port="outputs" />
                  </div>
                  {model.outputs.slice(0, 5).map((output) => (
                    <button
                      type="button"
                      className="ad-collab-file"
                      key={output.id}
                      onClick={() =>
                        output.kind === "artifact"
                          ? onOpenArtifacts()
                          : output.path &&
                            output.runId &&
                            onInspectChange(output.path, output.runId)
                      }
                      title={output.path ?? output.title}
                    >
                      <FileCode2 size={13} />
                      <span>{output.title}</span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                  {!model.outputs.length ? (
                    <p className="ad-collab-output-empty">文件修改与成果交付后会自动汇集。</p>
                  ) : null}
                  <button type="button" className="ad-collab-output-foot" onClick={onOpenArtifacts}>
                    查看任务全部成果
                    <ChevronRight size={12} />
                  </button>
                  {artifacts.error ? (
                    <p role="alert" className="ad-collab-fetch-error">
                      成果加载失败：{artifacts.error.message}
                    </p>
                  ) : null}
                </article>
                <article className="ad-collab-output ad-collab-report" data-collab-node>
                  <div className="ad-collab-output-heading">
                    <Radio size={18} />
                    <div>
                      <h4>协作动态</h4>
                      <p>最新执行事件</p>
                    </div>
                    <i className="ad-collab-port is-left" data-collab-port="events" />
                  </div>
                  <ol>
                    {model.events.map((record) => (
                      <li
                        key={record.seq}
                        style={colorStyle(colors.get(record.runId) ?? "var(--ad-brand)")}
                      >
                        <time>{clock(Date.parse(record.createdAt))}</time>
                        <p title={eventLabel(record)}>{eventLabel(record)}</p>
                      </li>
                    ))}
                  </ol>
                </article>
              </section>
            </div>
            <section className="ad-collab-timeline" aria-label="协作执行时间轴">
              <div className="ad-collab-timeline-heading">
                <h3>执行时间轴</h3>
                <p>每个成员，一条独立的轨迹</p>
                <span>{model.live ? "实时更新" : "历史记录"}</span>
              </div>
              <div className="ad-collab-scale">
                <span>成员 / 任务</span>
                <div>
                  {[0, 0.25, 0.5, 0.75, 1].map((part) => (
                    <span key={part}>{formatRunDuration(duration * part)}</span>
                  ))}
                </div>
              </div>
              {model.nodes.map((run) => (
                <button
                  type="button"
                  className="ad-collab-lane"
                  key={run.id}
                  style={colorStyle(colors.get(run.id) ?? "var(--ad-brand)")}
                  onClick={() => openRun(run)}
                  aria-label={`${AGENT_META[run.agent].label}，${COLLABORATION_STATUS[run.status]}，耗时 ${formatRunDuration((run.endedAt ?? end) - run.startedAt)}`}
                >
                  <span className="ad-collab-lane-name">
                    <i />
                    {run.id === model.root?.id ? "主控" : AGENT_META[run.agent].label}
                  </span>
                  <span className="ad-collab-lane-track">
                    <i
                      className={`ad-collab-lane-bar is-${run.status}`}
                      style={{
                        left: `${percentage(run.startedAt)}%`,
                        width: `${Math.max(0.3, percentage(run.endedAt ?? end) - percentage(run.startedAt))}%`,
                      }}
                    />
                  </span>
                </button>
              ))}
            </section>
          </>
        )}
      </section>
      <p className="ad-collab-caption">
        {paused
          ? "动效已暂停，执行状态仍会实时更新。"
          : model.live
            ? "正在同步本轮执行状态。"
            : "展示本轮真实执行记录。"}
      </p>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected ? `${AGENT_META[selected.agent].label} · 任务详情` : "任务详情"}
        description="查看任务目标、执行状态和返回结果。"
        footer={
          selected ? (
            <Button size="sm" variant="secondary" onClick={() => onInspectRun(selected.id)}>
              查看执行过程
              <ChevronRight size={13} className="ml-1" />
            </Button>
          ) : undefined
        }
      >
        {selected ? (
          <div className="ad-collab-detail">
            <div className="mb-4 flex items-center justify-between text-xs">
              <Status value={selected.status} />
              <span className="text-muted">
                {formatRunDuration((selected.endedAt ?? end) - selected.startedAt)} ·{" "}
                {selected.toolCount} 次工具调用
              </span>
            </div>
            <p className="mb-5 whitespace-pre-wrap text-sm leading-7">{selected.title}</p>
            {selected.error ? (
              <p role="alert" className="mb-4 rounded-lg bg-danger/10 p-3 text-xs text-danger">
                {selected.error}
              </p>
            ) : null}
            {selected.result ? (
              <Markdown>{selected.result}</Markdown>
            ) : (
              <p className="text-xs text-muted">
                {isRunActive(selected.status)
                  ? "结果会在执行过程中持续更新。"
                  : "本轮没有返回文本结果。"}
              </p>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

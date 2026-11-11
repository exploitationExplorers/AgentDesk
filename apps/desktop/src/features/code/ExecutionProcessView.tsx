import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  FileCode2,
  FileSearch,
  FolderSearch,
  Loader2,
  Search,
  Square,
  Terminal,
  Timer,
  Wrench,
  XCircle,
} from "lucide-react";
import type { Run, RunEventRecord, Task, TaskSession } from "@agentdesk/shared";
import { cn } from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";
import { stepHint, type CodeActivity, type CodeStep } from "./activity";
import {
  buildCollaborationModel,
  COLLABORATION_STATUS,
  formatRunDuration,
  isRunActive,
  type CollaborationRun,
  type CollaborationStatus,
} from "./collaboration-model";
import "./execution-process.css";

const EMPTY_ARTIFACTS: never[] = [];
const COLORS = [
  "var(--collab-sky)",
  "var(--collab-violet)",
  "var(--collab-mint)",
  "var(--collab-amber)",
  "var(--collab-coral)",
];
const colorStyle = (color: string): CSSProperties => ({ "--collab-color": color }) as CSSProperties;
const clock = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });

function hubLabel(agent: CollaborationRun["agent"]) {
  return agent === "orchestrator" ? "主控 · AgentDesk" : `主控 · ${AGENT_META[agent].label}`;
}

function laneLabel(run: CollaborationRun, rootId: string | null) {
  if (run.id === rootId) return hubLabel(run.agent);
  return AGENT_META[run.agent].label;
}

function Status({ value }: { value: CollaborationStatus }) {
  return (
    <span className={`ad-exec-process-status is-${value}`}>
      {value === "succeeded" ? <Check size={11} /> : null}
      {COLLABORATION_STATUS[value]}
    </span>
  );
}

function StepIcon({ status }: { status: CodeStep["status"] }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-info" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-danger" />;
  if (status === "cancelled") return <Square className="h-3.5 w-3.5 text-subtle" />;
  return <Check className="h-4 w-4 text-success" />;
}

function ToolIcon({ name }: { name: string }) {
  const Icon =
    name === "shell.run"
      ? Terminal
      : name === "fs.read"
        ? FileSearch
        : name === "fs.glob" || name === "fs.list"
          ? FolderSearch
          : name === "fs.write" || name === "fs.patch"
            ? FileCode2
            : /search|grep/.test(name)
              ? Search
              : Wrench;
  return <Icon size={15} aria-hidden="true" />;
}

const STEP_STATUS: Record<CodeStep["status"], string> = {
  running: "进行中",
  done: "完成",
  error: "失败",
  cancelled: "已停止",
};

export function ExecutionProcessView({
  task,
  runs,
  session,
  records,
  activity,
  selectedRunId,
  selectedStep,
  outputSelected,
  loading,
  approvalsError,
  approvalsSlot,
  pendingApprovalIds,
  onSelectRun,
  onSelectStep,
}: {
  task: Task;
  runs: Run[];
  session: TaskSession;
  records: RunEventRecord[];
  activity: CodeActivity;
  selectedRunId: string | null;
  selectedStep: string | null;
  outputSelected: boolean;
  loading?: boolean;
  approvalsError?: string | null;
  approvalsSlot?: ReactNode;
  pendingApprovalIds: ReadonlySet<string>;
  onSelectRun: (runId: string) => void;
  onSelectStep: (stepKey: string) => void;
}) {
  const [rootId, setRootId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const model = useMemo(
    () =>
      buildCollaborationModel({
        task,
        runs,
        session,
        records,
        artifacts: EMPTY_ARTIFACTS,
        pendingApprovalIds,
        rootId,
      }),
    [task, runs, session, records, pendingApprovalIds, rootId],
  );
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

  useEffect(() => {
    if (!model.live) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [model.live]);

  const end = model.live ? Math.max(now, model.endedAt) : model.endedAt;
  const duration = Math.max(1000, end - model.startedAt);
  const percentage = (value: number) =>
    Math.min(100, Math.max(0, ((value - model.startedAt) / duration) * 100));

  const activeRunId =
    (selectedRunId && model.nodes.some((run) => run.id === selectedRunId) && selectedRunId) ||
    (task.currentRunId && model.nodes.some((run) => run.id === task.currentRunId)
      ? task.currentRunId
      : null) ||
    model.root?.id ||
    model.nodes[0]?.id ||
    null;
  const activeRun = model.nodes.find((run) => run.id === activeRunId) ?? null;
  const persisted = runs.find((run) => run.id === activeRunId);
  const runSteps = activity.steps.filter((step) => step.runId === activeRunId);
  const roundStepCount = activity.steps.filter((step) =>
    model.nodes.some((run) => run.id === step.runId),
  ).length;

  return (
    <div className="ad-exec-process" data-testid="execution-process">
      <div className="ad-exec-process-top">
        <div className="ad-exec-process-metrics">
          {model.live ? (
            <span className="ad-exec-process-live">
              <i aria-hidden="true" />
              实时更新
            </span>
          ) : (
            <span>历史记录</span>
          )}
          <span>
            <b>{roundStepCount}</b> 个步骤 · <b>{model.nodes.length}</b> 个 Agent
          </span>
          <span className="inline-flex items-center gap-1">
            <Timer size={12} />
            {formatRunDuration(end - model.startedAt)}
          </span>
          {model.members.length > 0 ? (
            <span>
              <b>{model.completed}</b> / {model.members.length} 子任务完成
            </span>
          ) : null}
        </div>
        {model.roots.length > 1 ? (
          <label className="ad-exec-process-round">
            执行轮次
            <select
              aria-label="执行轮次"
              value={model.root?.id ?? ""}
              onChange={(event) => {
                setRootId(event.target.value || null);
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
      </div>

      <div className="ad-exec-process-goal">
        <span>任务目标</span>
        <p title={task.goal}>{task.goal}</p>
      </div>

      <section className="ad-exec-process-lanes" aria-label="Agent 执行时间轴">
        <div className="ad-exec-process-lanes-heading">
          <h3>Agent 时间轴</h3>
          <p>每个 Agent，一条独立轨迹</p>
        </div>
        {!model.nodes.length ? (
          <p className="ad-exec-process-empty">
            {loading ? "正在加载执行记录…" : "等待执行记录。任务开始后，Agent 车道会显示在这里。"}
          </p>
        ) : (
          <>
            <div className="ad-exec-process-scale">
              <span>Agent</span>
              <div>
                {[0, 0.25, 0.5, 0.75, 1].map((part) => (
                  <span key={part}>{formatRunDuration(duration * part)}</span>
                ))}
              </div>
            </div>
            {model.nodes.map((run) => (
              <button
                type="button"
                key={run.id}
                className={cn("ad-exec-process-lane", activeRunId === run.id && "is-selected")}
                style={colorStyle(colors.get(run.id) ?? "var(--ad-brand)")}
                onClick={() => onSelectRun(run.id)}
                aria-pressed={activeRunId === run.id}
                aria-label={`${laneLabel(run, model.root?.id ?? null)}，${COLLABORATION_STATUS[run.status]}，耗时 ${formatRunDuration((run.endedAt ?? end) - run.startedAt)}`}
              >
                <span className="ad-exec-process-lane-name">
                  <i aria-hidden="true" />
                  <span>{run.id === model.root?.id ? "主控" : AGENT_META[run.agent].label}</span>
                </span>
                <span className="ad-exec-process-lane-track">
                  <i
                    className={`ad-exec-process-lane-bar is-${run.status}`}
                    style={{
                      left: `${percentage(run.startedAt)}%`,
                      width: `${Math.max(0.3, percentage(run.endedAt ?? end) - percentage(run.startedAt))}%`,
                    }}
                  />
                </span>
              </button>
            ))}
          </>
        )}
      </section>

      {activeRun ? (
        <section className="ad-exec-process-detail" aria-label="选中 Agent 的执行步骤">
          <div className="ad-exec-process-detail-head">
            <strong>{laneLabel(activeRun, model.root?.id ?? null)}</strong>
            {activeRun.parentId ? <span className="text-subtle">委派任务</span> : null}
            <Status value={activeRun.status} />
            <span className="ad-exec-process-meta">
              {clock(activeRun.startedAt)} · {activeRun.toolCount} 次工具调用
            </span>
          </div>
          <div className="ad-exec-process-steps-heading">
            <span>
              工具步骤 <b>{runSteps.length}</b>
            </span>
            <span>
              点击查看输出 <ChevronRight size={11} aria-hidden="true" />
            </span>
          </div>
          <div className="ad-exec-process-steps">
            {runSteps.map((step, index) => {
              const status =
                step.status === "running" &&
                (activeRun.status === "failed" || activeRun.status === "cancelled")
                  ? activeRun.status === "cancelled"
                    ? "cancelled"
                    : "error"
                  : step.status;
              return (
                <button
                  key={step.key}
                  type="button"
                  className={cn(
                    "ad-exec-process-step",
                    selectedStep === step.key && outputSelected && "is-selected",
                  )}
                  data-status={status}
                  aria-pressed={selectedStep === step.key && outputSelected}
                  onClick={() => onSelectStep(step.key)}
                >
                  <span className="ad-exec-process-step-icon">
                    <ToolIcon name={step.name} />
                  </span>
                  <span className="ad-exec-process-step-body">
                    <span className="ad-exec-process-step-title">
                      <strong>{TOOL_LABELS[step.name] ?? step.name}</strong>
                      <span className="ad-exec-process-step-number">
                        #{String(index + 1).padStart(2, "0")}
                      </span>
                    </span>
                    <span className="ad-exec-process-step-hint" title={stepHint(step)}>
                      {stepHint(step) || step.name}
                    </span>
                  </span>
                  <span className="ad-exec-process-step-meta">
                    <span className="ad-exec-process-step-state">
                      <StepIcon status={status} />
                      <span>{STEP_STATUS[status]}</span>
                    </span>
                    <time dateTime={step.createdAt}>
                      {clock(new Date(step.createdAt).getTime())}
                    </time>
                  </span>
                  <ChevronRight
                    className="ad-exec-process-step-arrow"
                    size={13}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
            {!runSteps.length && isRunActive(activeRun.status) ? (
              <p className="ad-exec-process-empty">正在理解任务、读取项目上下文…</p>
            ) : null}
            {!runSteps.length && !isRunActive(activeRun.status) ? (
              <p className="ad-exec-process-empty">本轮没有工具步骤记录。</p>
            ) : null}
          </div>
          {(activity.textByRun.get(activeRun.id) || activeRun.result || persisted?.resultText) && (
            <div className="mt-3 text-[13px]">
              <Markdown>
                {activity.textByRun.get(activeRun.id) ||
                  activeRun.result ||
                  persisted?.resultText ||
                  ""}
              </Markdown>
            </div>
          )}
          {(activeRun.error || persisted?.resultError) && (
            <p className="mt-2 text-xs text-danger">{activeRun.error || persisted?.resultError}</p>
          )}
        </section>
      ) : null}

      {approvalsSlot}
      {approvalsError ? (
        <p className="text-xs text-danger">无法同步审批：{approvalsError}</p>
      ) : null}
    </div>
  );
}

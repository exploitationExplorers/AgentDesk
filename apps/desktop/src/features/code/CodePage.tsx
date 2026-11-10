import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Circle,
  Code2,
  FileCode2,
  GitCompareArrows,
  Loader2,
  Network,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { Approval, Run, Task } from "@agentdesk/shared";
import { Button, Segmented, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@agentdesk/ui";
import { AppMark } from "../../components/AppMark";
import { Markdown } from "../../components/Markdown";
import { TOOL_LABELS } from "../../lib/agents";
import { approvalDisplay } from "../../lib/approval-display";
import { isCliWorkbench } from "../../lib/tauri";
import { toast } from "../../lib/toast";
import { codeRoute } from "../../router";
import { codeApi, type CodeSource } from "./api";
import { outputText, projectActivity, stepHint, type CodeStep } from "./activity";
import { DiffView } from "./DiffView";
import { ArtifactWorkspace } from "./ArtifactWorkspace";
import { FlowGraph } from "./FlowGraph";
import { useRunTree } from "./useRunTree";
import { useTaskEvents } from "./useTaskEvents";
import { CollaborationView } from "./CollaborationView";
import { CliTerminal } from "./CliTerminal";

const STATUS: Record<Task["status"], string> = {
  pending: "待开始",
  queued: "排队中",
  planning: "规划中",
  awaiting_plan_approval: "方案待确认",
  running: "执行中",
  awaiting_review: "待验收",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  closed: "已归档",
};
const activeTask = (task: Task) => ["queued", "planning", "running"].includes(task.status);
/** 可归档：终态 + 待验收（清空侧栏历史）；进行中的执行不清理。 */
const CLEARABLE: ReadonlySet<Task["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "awaiting_review",
]);
const fileName = (path: string) => path.replace(/\\/g, "/").split("/").at(-1) ?? path;
const time = (date: string) =>
  new Date(date).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function StepIcon({ status }: { status: CodeStep["status"] }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-info" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-danger" />;
  if (status === "cancelled") return <Square className="h-3.5 w-3.5 text-subtle" />;
  return <Check className="h-4 w-4 text-success" />;
}

function ApprovalCard({
  approval,
  source,
  refresh,
}: {
  approval: Approval;
  source: CodeSource;
  refresh: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const display = approvalDisplay(approval);
  const action = useMutation({
    mutationFn: (approved: boolean) =>
      approval.kind === "question" && approved
        ? codeApi(source).answer(approval.id, answer)
        : codeApi(source).approve(approval.id, approved),
    onSuccess: refresh,
  });
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-warning" />
        {approval.kind === "question" ? "需要你补充信息" : `需要授权：${display.title}`}
      </p>
      <p className="my-3 whitespace-pre-wrap text-xs leading-5 text-muted">
        {approval.kind === "question" ? approval.detail : display.detail}
      </p>
      {display.technicalDetail ? (
        <details className="mb-3 text-xs text-subtle">
          <summary className="cursor-pointer hover:text-fg">查看命令与工作目录</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-[11px]">
            {display.technicalDetail}
          </pre>
        </details>
      ) : null}
      {approval.kind === "question" && (
        <textarea
          aria-label="补充回答"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          className="mb-3 w-full rounded-lg border bg-surface p-2 text-sm"
        />
      )}
      {action.error && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {action.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={action.isPending}
          disabled={approval.kind === "question" && !answer.trim()}
          onClick={() => action.mutate(true)}
        >
          {approval.kind === "question" ? "发送回答" : "批准执行"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={action.isPending}
          onClick={() => action.mutate(false)}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}

function NewTask({
  source,
  onCreated,
  onClose,
}: {
  source: CodeSource;
  onCreated: (task: Task) => void;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const projects = useQuery({
    queryKey: ["code-projects", source],
    queryFn: codeApi(source).projects,
  });
  const create = useMutation({
    mutationFn: () => {
      const project = projects.data?.find((p) => p.id === projectId);
      if (!project) throw new Error("请选择已登记的目标项目。");
      return codeApi(source).create(goal.trim(), goal.trim(), project.path);
    },
    onSuccess: onCreated,
  });
  const addProject = useMutation({
    mutationFn: () => codeApi(source).addProject(projectPath.trim()),
    onSuccess: async (project) => {
      await projects.refetch();
      setProjectId(project.id);
      setProjectPath("");
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (projectId && goal.trim()) create.mutate();
      }}
      className="mx-auto w-full max-w-2xl rounded-2xl border bg-surface p-6 shadow-sm"
    >
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">交给 AgentDesk 一项编码任务</h2>
          <p className="mt-1 text-xs text-muted">选择项目，描述目标，查看它逐步完成。</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭新任务"
          className="rounded-lg p-2 hover:bg-surface-2"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <label className="block text-xs font-medium">
        项目
        <select
          aria-label="目标项目"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="mt-2 block w-full rounded-lg border bg-bg px-3 py-2 text-sm"
        >
          <option value="">选择已登记的本地项目</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.path}
            </option>
          ))}
        </select>
      </label>
      {projects.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {projects.error.message}
        </p>
      )}
      {projects.data?.length === 0 && (
        <p className="mt-2 text-xs text-muted">此来源还没有项目。添加一个本地 Git 仓库即可开始。</p>
      )}
      <details
        className="mt-3 text-xs text-muted"
        open={projects.data?.length === 0 ? true : undefined}
      >
        <summary className="cursor-pointer">添加本地项目</summary>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="本地仓库路径"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="例如 D:/projects/my-app"
            className="min-w-0 flex-1 rounded-lg border bg-bg px-3 py-2 font-mono"
          />
          <Button
            type="button"
            size="sm"
            disabled={!projectPath.trim()}
            loading={addProject.isPending}
            onClick={() => addProject.mutate()}
          >
            添加项目
          </Button>
        </div>
        {addProject.error && (
          <p role="alert" className="mt-2 text-danger">
            {addProject.error.message}
          </p>
        )}
      </details>
      <label className="mt-4 block text-xs font-medium">
        任务目标
        <textarea
          aria-label="任务目标"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="例如：修复登录后刷新页面丢失状态的问题，并运行相关测试。"
          rows={4}
          className="mt-2 w-full resize-y rounded-lg border bg-bg p-3 text-sm leading-relaxed"
        />
      </label>
      {create.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {create.error.message}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-4">
        <span className="text-xs text-subtle">修改和命令执行按现有规则请求审批。</span>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={!projectId || !goal.trim()}
        >
          开始编码 <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

function TaskDetail({ task, source }: { task: Task; source: CodeSource }) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["code"] });
  };
  const runs = useQuery({
    queryKey: ["code", source, task.id, "runs"],
    queryFn: () => codeApi(source).runs(task.id),
    refetchInterval: 2000,
  });
  const approvals = useQuery({
    queryKey: ["code", source, "approvals"],
    queryFn: codeApi(source).approvals,
    refetchInterval: 1500,
  });
  const { records, error } = useTaskEvents(source, task);
  const activity = useMemo(() => projectActivity(records), [records]);
  const runTree = useRunTree(records);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [timelineView, setTimelineView] = useState<"timeline" | "flow">("timeline");
  const [workspaceView, setWorkspaceView] = useState<"execution" | "collaboration">("execution");
  const [tab, setTab] = useState<"diff" | "output" | "artifacts">("diff");
  const [followup, setFollowup] = useState("");
  const change = activity.changes.find((c) => c.key === selectedChange) ?? activity.changes.at(-1);
  const step =
    activity.steps.find((s) => s.key === selectedStep) ??
    activity.steps.filter((s) => s.name === "shell.run").at(-1) ??
    activity.steps.at(-1);
  const currentRun = runs.data?.find((r) => r.id === task.currentRunId);
  const pending =
    approvals.data?.filter(
      (a) =>
        activity.approvalIds.has(a.id) ||
        (a.payload &&
          typeof a.payload === "object" &&
          "taskId" in a.payload &&
          a.payload.taskId === task.id),
    ) ?? [];
  const busy = currentRun ? ["running", "queued"].includes(currentRun.status) : activeTask(task);
  const action = useMutation({
    mutationFn: (kind: "cancel" | "review" | "followup") => {
      if (kind === "cancel") return codeApi(source).cancel(task.id);
      if (kind === "review") return codeApi(source).review(task.id);
      const trigger = ["failed", "cancelled"].includes(task.status)
        ? "resume"
        : task.status === "running"
          ? "continue"
          : "followup";
      return codeApi(source).followup(
        task.id,
        followup.trim() || "继续完成原任务，并验证已有改动。",
        trigger,
      );
    },
    onSuccess: () => {
      setFollowup("");
      refresh();
    },
  });
  const total = activity.changes.reduce(
    (n, c) => ({ add: n.add + c.change.additions, del: n.del + c.change.deletions }),
    { add: 0, del: 0 },
  );
  const files = new Set(activity.changes.map((c) => c.change.path)).size;
  const runList: Run[] = runs.data ?? [];
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    const last = activity.steps.filter((s) => s.runId === runId).at(-1);
    if (last) {
      setSelectedStep(last.key);
      setTab("output");
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <h2 className="max-w-[50vw] truncate text-sm font-semibold" title={task.title}>
            {task.title}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-subtle">
            {task.agent ?? "orchestrator"} <span className="mx-2">/</span> {task.id.slice(0, 8)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant={workspaceView === "collaboration" ? "secondary" : "ghost"}
            aria-pressed={workspaceView === "collaboration"}
            onClick={() =>
              setWorkspaceView((value) =>
                value === "collaboration" ? "execution" : "collaboration",
              )
            }
          >
            <Network className="mr-1.5 h-3.5 w-3.5" />
            {workspaceView === "collaboration" ? "返回执行现场" : "协作视图"}
          </Button>
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              busy ? "text-emerald-500" : "text-muted",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                busy ? "animate-pulse bg-emerald-400" : "bg-subtle",
              )}
            />
            {pending.length ? "等待你的确认" : STATUS[task.status]}
          </span>
          {busy && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => action.mutate("cancel")}
            >
              <Square className="mr-1.5 h-3 w-3" />
              停止
            </Button>
          )}
          {task.status === "awaiting_review" && (
            <Button
              size="sm"
              variant="primary"
              loading={action.isPending}
              onClick={() => action.mutate("review")}
            >
              确认完成
            </Button>
          )}
        </div>
      </div>
      {(error || action.error || runs.error) && (
        <div role="alert" className="border-b bg-danger/5 px-6 py-2 text-xs text-danger">
          {error ?? action.error?.message ?? runs.error?.message}{" "}
          {error && "· 正在重试同步，已显示的记录会保留。"}
        </div>
      )}
      {workspaceView === "collaboration" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {pending.length > 0 ? (
            <div className="space-y-3 px-6 pt-4">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  source={source}
                  refresh={refresh}
                />
              ))}
            </div>
          ) : null}
          {approvals.error ? (
            <p role="alert" className="px-6 pt-4 text-xs text-danger">
              无法同步审批：{approvals.error.message}
            </p>
          ) : null}
          <CollaborationView
            task={task}
            source={source}
            runs={runList}
            session={runTree}
            records={records}
            approvals={pending}
            onInspectRun={(runId) => {
              selectRun(runId);
              setWorkspaceView("execution");
            }}
            onInspectChange={(path, runId) => {
              const match = activity.changes.findLast(
                (item) => item.runId === runId && item.change.path === path,
              );
              if (match) setSelectedChange(match.key);
              setTab("diff");
              setWorkspaceView("execution");
            }}
            onOpenArtifacts={() => {
              setTab("artifacts");
              setWorkspaceView("execution");
            }}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(300px,0.85fr)_minmax(360px,1.15fr)]">
          <section className="flex min-h-0 min-w-0 flex-col border-r" aria-label="执行时间线">
            <Tabs
              value={timelineView}
              onValueChange={(value) => setTimelineView(value as "timeline" | "flow")}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex items-center justify-between px-5 pt-2">
                <TabsList className="w-auto">
                  <TabsTrigger value="timeline">执行过程</TabsTrigger>
                  <TabsTrigger value="flow">流程图</TabsTrigger>
                </TabsList>
                <span className="text-xs text-subtle">{activity.steps.length} 个步骤</span>
              </div>
              <TabsContent
                value="timeline"
                className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3"
              >
                <div className="mb-5 rounded-xl bg-surface-2/70 p-3.5">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-subtle">
                    任务目标
                  </p>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{task.goal}</p>
                </div>
                {runList.map((run) => (
                  <div key={run.id} className="mb-5">
                    <div className="mb-3 flex items-center gap-2 text-xs">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg border bg-surface">
                        <Code2 className="h-3.5 w-3.5 text-emerald-500" />
                      </span>
                      <span className="font-medium">
                        {run.agent === "code" ? "编码助手" : run.agent}
                      </span>
                      {run.parentRunId && <span className="text-subtle">委派任务</span>}
                      <span className="ml-auto font-mono text-[10px] text-subtle">
                        {time(run.createdAt)}
                      </span>
                    </div>
                    <div className="ml-3 border-l pl-4">
                      {activity.steps
                        .filter((s) => s.runId === run.id)
                        .map((s) => (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => {
                              setSelectedStep(s.key);
                              setTab("output");
                            }}
                            className={cn(
                              "mb-1.5 flex w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-2",
                              selectedStep === s.key && tab === "output" && "bg-surface-2",
                            )}
                          >
                            <span className="mt-0.5 shrink-0">
                              <StepIcon
                                status={
                                  s.status === "running" &&
                                  ["failed", "cancelled"].includes(run.status)
                                    ? "error"
                                    : s.status
                                }
                              />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-xs font-medium">
                                {TOOL_LABELS[s.name] ?? s.name}
                              </span>
                              <span
                                className="mt-1 block truncate font-mono text-[11px] text-subtle"
                                title={stepHint(s)}
                              >
                                {stepHint(s)}
                              </span>
                            </span>
                          </button>
                        ))}
                      {(activity.textByRun.get(run.id) || run.resultText) && (
                        <div className="mt-3 text-[13px]">
                          <Markdown>
                            {activity.textByRun.get(run.id) || run.resultText || ""}
                          </Markdown>
                        </div>
                      )}
                      {run.resultError && (
                        <p className="mt-2 text-xs text-danger">{run.resultError}</p>
                      )}
                      {run.status === "running" &&
                        !activity.steps.some((s) => s.runId === run.id) && (
                          <p className="py-3 text-xs text-subtle">正在理解任务、读取项目上下文…</p>
                        )}
                    </div>
                  </div>
                ))}
                {runs.isLoading && <p className="py-4 text-xs text-subtle">正在加载执行记录…</p>}
                {pending.map((approval) => (
                  <div className="mb-3" key={approval.id}>
                    <ApprovalCard approval={approval} source={source} refresh={refresh} />
                  </div>
                ))}
                {approvals.error && (
                  <p className="text-xs text-danger">无法同步审批：{approvals.error.message}</p>
                )}
              </TabsContent>
              <TabsContent value="flow" className="relative min-h-0 flex-1 pt-2">
                <FlowGraph
                  runsById={runTree.runsById}
                  rootOrder={runTree.rootOrder}
                  selectedRunId={selectedRunId}
                  onSelectRun={selectRun}
                />
              </TabsContent>
            </Tabs>
            {task.purpose === "reference_analysis" && (
              <p className="border-t p-4 text-xs text-muted">
                资料分析为只读记录，请到项目中心勾选建议创建开发任务。
              </p>
            )}
            {task.purpose !== "reference_analysis" &&
              !["closed", "completed"].includes(task.status) && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    action.mutate("followup");
                  }}
                  className="border-t p-4"
                >
                  <div className="flex items-center gap-2 rounded-xl border bg-surface p-2">
                    <input
                      aria-label="后续要求"
                      value={followup}
                      onChange={(e) => setFollowup(e.target.value)}
                      disabled={busy || task.status === "awaiting_plan_approval"}
                      placeholder={
                        busy ? "执行中，可在此查看实时进展" : "补充要求，或继续完成任务…"
                      }
                      className="min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      disabled={
                        busy || task.status === "awaiting_plan_approval" || action.isPending
                      }
                      aria-label="继续任务"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] text-subtle">执行记录自动保存，可随时回来查看。</p>
                </form>
              )}
          </section>
          <section className="flex min-h-0 min-w-0 flex-col bg-surface/35" aria-label="代码检查器">
            <div className="flex items-center gap-5 border-b px-5">
              <button
                type="button"
                onClick={() => setTab("diff")}
                className={cn(
                  "flex items-center gap-2 border-b-2 py-3.5 text-xs",
                  tab === "diff" ? "border-emerald-400 text-fg" : "border-transparent text-muted",
                )}
              >
                <GitCompareArrows className="h-3.5 w-3.5" />
                文件变更 <span className="rounded bg-surface-2 px-1.5 text-[10px]">{files}</span>
              </button>
              <button
                type="button"
                onClick={() => setTab("output")}
                className={cn(
                  "flex items-center gap-2 border-b-2 py-3.5 text-xs",
                  tab === "output" ? "border-emerald-400 text-fg" : "border-transparent text-muted",
                )}
              >
                <Terminal className="h-3.5 w-3.5" />
                工具输出
              </button>
              <button
                type="button"
                onClick={() => setTab("artifacts")}
                className={cn(
                  "flex items-center gap-2 border-b-2 py-3.5 text-xs",
                  tab === "artifacts"
                    ? "border-emerald-400 text-fg"
                    : "border-transparent text-muted",
                )}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                成果
              </button>
              <div className="ml-auto font-mono text-[11px]">
                <span className="text-success">+{total.add}</span>
                <span className="ml-2 text-danger">−{total.del}</span>
              </div>
            </div>
            {tab === "artifacts" ? (
              <ArtifactWorkspace taskId={task.id} source={source} />
            ) : tab === "diff" ? (
              change ? (
                <>
                  <div className="max-h-40 shrink-0 overflow-y-auto border-b p-2">
                    {activity.changes.map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        onClick={() => setSelectedChange(item.key)}
                        title={item.change.path}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs",
                          change.key === item.key
                            ? "bg-surface-2"
                            : "text-muted hover:bg-surface-2/50",
                        )}
                      >
                        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        <span className="truncate font-mono">{fileName(item.change.path)}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-subtle">
                          {time(item.createdAt)}
                        </span>
                        <span className="text-success">+{item.change.additions}</span>
                        <span className="text-danger">−{item.change.deletions}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 border-b px-4 py-3">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
                      title={change.change.path}
                    >
                      {change.change.path}
                    </span>
                    <span className="shrink-0 rounded bg-success/10 px-2 py-0.5 text-[10px] text-success">
                      {change.change.operation === "create" ? "已创建" : "已写入"}
                    </span>
                  </div>
                  <DiffView change={change.change} />
                  <p className="border-t px-4 py-2 text-[10px] text-subtle">
                    展示每次实际写入的差异 · 统计为累计编辑量
                  </p>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                  <div className="mb-4 rounded-2xl border border-dashed p-5 text-subtle">
                    <GitCompareArrows className="h-7 w-7" />
                  </div>
                  <p className="text-sm font-medium">代码改动会出现在这里</p>
                  <p className="mt-2 max-w-60 text-xs leading-6 text-subtle">
                    Agent 读取、定位并写入文件后，你可以逐行查看新增和删除。
                  </p>
                  <div className="mt-6 flex gap-3 font-mono text-[11px] text-subtle">
                    <span>读取</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                    <span>编辑</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                    <span>验证</span>
                  </div>
                </div>
              )
            ) : step ? (
              <>
                <div className="border-b px-4 py-3">
                  <p className="text-xs font-medium">{TOOL_LABELS[step.name] ?? step.name}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-subtle">
                    {stepHint(step)}
                  </p>
                </div>
                <pre
                  className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6"
                  data-testid="tool-output"
                >
                  {step.output ||
                    outputText(step.result) ||
                    (step.status === "running" ? "等待工具输出…" : "此步骤没有输出。")}
                </pre>
                <details className="border-t p-3 text-xs text-muted">
                  <summary className="cursor-pointer">调用参数</summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
                    {outputText(step.args)}
                  </pre>
                </details>
              </>
            ) : (
              <div className="grid flex-1 place-items-center p-8 text-xs text-subtle">
                执行命令后，输出会实时显示在这里。
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function CodePage() {
  const search = codeRoute.useSearch();
  // CLI 内置工作台已经连接当前实例，不能再发现另一个默认数据目录。
  const cliWorkbench = isCliWorkbench();
  const source = cliWorkbench ? "workbench" : (search.source ?? "workbench");
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const client = useQueryClient();
  const tasks = useQuery({
    queryKey: ["code", source, "tasks"],
    queryFn: codeApi(source).tasks,
    refetchInterval: 2000,
    retry: false,
    enabled: source !== "cli",
  });
  const sorted = useMemo(
    () =>
      [...(tasks.data ?? [])]
        .filter((task) => task.status !== "closed")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks.data],
  );
  const clearable = useMemo(() => sorted.filter((task) => CLEARABLE.has(task.status)), [sorted]);
  const clearTasks = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        clearable.map((task) => codeApi(source).close(task.id)),
      );
      const closed = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - closed;
      return { closed, failed, skipped: sorted.length - clearable.length };
    },
    onSuccess: async ({ closed, failed, skipped }) => {
      const clearedSelected = Boolean(search.task && clearable.some((t) => t.id === search.task));
      await client.invalidateQueries({ queryKey: ["code", source] });
      if (clearedSelected) void navigate({ to: "/code", search: { source } });
      const parts = [`已归档 ${closed} 项`];
      if (skipped) parts.push(`${skipped} 项仍在进行中，未清理`);
      if (failed) parts.push(`${failed} 项归档失败`);
      toast(parts.join("；"), { tone: failed ? "warning" : "success" });
    },
    onError: (error: Error) => toast(error.message || "清空失败", { tone: "danger" }),
  });
  const selected =
    sorted.find((t) =>
      search.task ? t.id === search.task : search.c ? t.conversationId === search.c : false,
    ) ?? (!search.task && !search.c ? sorted[0] : undefined);
  const choose = (id: string) => {
    setCreating(false);
    void navigate({ to: "/code", search: { source, task: id } });
  };
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-4 border-b px-6 py-5 pr-[4.5rem]">
        <AppMark alt="AgentDesk" className="h-10 w-10 shrink-0" />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">编码</h1>
          <p className="mt-0.5 text-xs text-muted">从读文件到验证，每一步都在这里。</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {cliWorkbench ? (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Terminal className="h-3.5 w-3.5" /> 与 CLI 同步
            </span>
          ) : (
            <Segmented
              label="编码会话来源"
              value={source}
              options={[
                { value: "workbench", label: "工作台" },
                { value: "cli", label: "CLI 会话" },
              ]}
              onChange={(value) => {
                setCreating(false);
                void navigate({ to: "/code", search: { source: value } });
              }}
            />
          )}
          {source !== "cli" && (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              新任务
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {source === "cli" ? (
          <CliTerminal />
        ) : (
          <>
            <aside
              className="lb-glass flex w-[220px] shrink-0 flex-col border-r max-md:w-[170px]"
              aria-label="编码任务列表"
            >
              <div className="flex items-center justify-between px-4 py-4">
                <span className="text-[11px] font-medium text-muted">
                  任务与会话 <span className="ml-1 text-subtle">{sorted.length}</span>
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (!clearable.length) {
                        toast("没有可归档的任务（待验收 / 已完成 / 失败 / 已停止）", {
                          tone: "info",
                        });
                        return;
                      }
                      if (
                        !window.confirm(
                          `将归档 ${clearable.length} 项任务（含待验收 / 已完成 / 失败 / 已停止）。进行中的任务会保留。确定清空？`,
                        )
                      )
                        return;
                      clearTasks.mutate();
                    }}
                    disabled={clearTasks.isPending || !sorted.length}
                    aria-label="清空终态任务"
                    title="清空终态任务"
                    className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                  >
                    <Trash2 className={cn("h-3 w-3", clearTasks.isPending && "animate-pulse")} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void tasks.refetch()}
                    aria-label="刷新任务"
                    className="rounded p-1 text-subtle hover:bg-surface-2"
                  >
                    <RefreshCw className={cn("h-3 w-3", tasks.isFetching && "animate-spin")} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2">
                {sorted.map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    onClick={() => choose(task.id)}
                    className={cn(
                      "mb-1 w-full rounded-xl border px-3 py-3 text-left",
                      selected?.id === task.id && !creating
                        ? "border-border-strong bg-surface-2"
                        : "border-transparent hover:bg-surface-2/50",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Circle
                        className={cn(
                          "mt-1 h-2 w-2 shrink-0 fill-current",
                          activeTask(task)
                            ? "text-emerald-400"
                            : task.status === "failed"
                              ? "text-danger"
                              : "text-subtle",
                        )}
                      />
                      <span className="line-clamp-2 text-xs font-medium leading-5">
                        {task.title}
                      </span>
                    </div>
                    <div className="mt-2 flex justify-between pl-4 text-[10px] text-subtle">
                      <span>{STATUS[task.status]}</span>
                      <span>
                        {new Date(task.updatedAt).toLocaleDateString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                        })}
                      </span>
                    </div>
                  </button>
                ))}
                {!sorted.length && (
                  <p className="px-3 py-8 text-center text-xs text-subtle">
                    {tasks.isLoading ? "正在连接…" : "还没有任务"}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 border-t px-4 py-3 text-[10px] text-subtle">
                <Radio
                  className={cn("h-3 w-3", tasks.error ? "text-danger" : "text-emerald-500")}
                />
                {tasks.error ? "连接不可用" : "自动同步 · 本机运行"}
              </div>
            </aside>
            {creating ? (
              <div className="min-w-0 flex-1 overflow-y-auto p-8">
                <NewTask
                  key={source}
                  source={source}
                  onClose={() => setCreating(false)}
                  onCreated={(task) => {
                    void client.invalidateQueries({ queryKey: ["code", source] });
                    choose(task.id);
                  }}
                />
              </div>
            ) : selected ? (
              <TaskDetail key={`${source}:${selected.id}`} task={selected} source={source} />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col items-center justify-center p-8">
                <AppMark alt="AgentDesk" className="mb-7 h-20 w-20" />
                <p className="mb-3 font-mono text-[10px] tracking-[0.24em] text-emerald-500">
                  AGENTDESK / CODE
                </p>
                <h2 className="text-2xl font-semibold tracking-tight">看见想法，变成代码。</h2>
                <p className="mt-3 max-w-md text-center text-sm leading-7 text-muted">
                  {tasks.error
                    ? tasks.error.message
                    : search.task || search.c
                      ? "暂未找到对应任务，等待会话产生执行记录。"
                      : "给 Agent 一个明确的目标。文件读取、代码差异与验证结果，会在同一个现场逐步呈现。"}
                </p>
                <div className="my-8 flex items-center gap-5 text-xs text-muted">
                  <span className="flex items-center gap-2">
                    <FileCode2 className="h-4 w-4" />
                    读取项目
                  </span>
                  <ArrowRight className="h-3 w-3 text-subtle" />
                  <span className="flex items-center gap-2">
                    <GitCompareArrows className="h-4 w-4" />
                    查看差异
                  </span>
                  <ArrowRight className="h-3 w-3 text-subtle" />
                  <span className="flex items-center gap-2">
                    <Terminal className="h-4 w-4" />
                    运行验证
                  </span>
                </div>
                <Button
                  variant="primary"
                  onClick={() => (tasks.error ? void tasks.refetch() : setCreating(true))}
                >
                  {tasks.error ? "重新连接" : "开始第一项任务"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Link to="/" className="mt-5 text-xs text-subtle hover:text-fg">
                  也可以从 Bot 对话中发起 <ArrowDown className="ml-1 inline h-3 w-3" />
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

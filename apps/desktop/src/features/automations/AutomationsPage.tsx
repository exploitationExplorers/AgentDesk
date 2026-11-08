import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronDown, Play, Plus, Repeat2, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AutomationBinding, AutomationBindingInput, Task } from "@agentdesk/shared";
import {
  AnimatedDisclosure,
  AnimatePresence,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  PageHeader,
  PageMetrics,
  PageSurface,
  Segmented,
  Select,
  Spinner,
  Textarea,
  motion,
  gridItemVariants,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { automationStatusLabel } from "./status";
import { clearPendingEvent, preparePendingEvent } from "./pending";
import { AutomationRecovery } from "./AutomationRecovery";

function CreateAutomation({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");
  const [root, setRoot] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [time, setTime] = useState("18:00");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [maxRounds, setMaxRounds] = useState("20");
  const [maxMinutes, setMaxMinutes] = useState("30");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const create = useMutation({
    mutationFn: api.createAutomation,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["automations"] });
      void client.invalidateQueries({ queryKey: ["autoloop-status"] });
      onClose();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const [hour, minute] = time.split(":").map(Number);
    const input: AutomationBindingInput = {
      title: title.trim(),
      goal: goal.trim(),
      projectId: projectId || null,
      workspacePolicy: { root: root.trim(), allowSubdirectories: true },
      schedule: scheduled ? { cron: `${minute} ${hour} * * *`, timezone } : null,
      maxRounds: Number(maxRounds),
      maxMinutes: Number(maxMinutes),
      ...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}),
      ...(maxCostUsd.trim() ? { maxCostUsd: Number(maxCostUsd) } : {}),
    };
    create.mutate(input);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !create.isPending && onClose()}
      title="新建自动化"
      description="设定目标，遇到需要你决定的地方会在会话中等待。"
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="automation-title">名称</Label>
          <Input
            id="automation-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            placeholder="每周项目汇报"
          />
        </div>
        <div>
          <Label htmlFor="automation-goal">任务目标</Label>
          <Textarea
            id="automation-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            maxLength={4000}
            required
            placeholder="根据项目资料整理进展和风险，生成一份汇报 PPT。"
          />
        </div>
        <div>
          <Label htmlFor="automation-project">关联项目</Label>
          <Select
            id="automation-project"
            value={projectId}
            onChange={(event) => {
              const id = event.target.value;
              setProjectId(id);
              const project = projects.data?.find((item) => item.id === id);
              if (project) setRoot(project.path);
            }}
          >
            <option value="">选择项目或填写工作目录</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="automation-root">工作目录</Label>
          <Input
            id="automation-root"
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            required
            placeholder="选择项目后自动填入"
          />
          <p className="mt-1 text-xs text-muted">
            任务将在这个目录处理资料；需要授权的操作会单独确认。
          </p>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(event) => setScheduled(event.target.checked)}
          />
          每天定时执行
        </label>
        {scheduled ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="automation-time">时间</Label>
              <Input
                id="automation-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="automation-timezone">时区</Label>
              <Input
                id="automation-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
              />
            </div>
            <p className="col-span-2 text-xs text-muted">
              应用运行时自动执行；设备休眠期间错过的时间，恢复后补最近一次。
              当前所有已启用的定时自动化共用一个时区。
            </p>
          </div>
        ) : null}
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer text-sm text-muted">执行限额</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="automation-rounds">最多处理轮数</Label>
              <Input
                id="automation-rounds"
                type="number"
                min={1}
                max={100}
                value={maxRounds}
                required
                onChange={(event) => setMaxRounds(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="automation-minutes">最长执行时间（分钟）</Label>
              <Input
                id="automation-minutes"
                type="number"
                min={1}
                max={120}
                value={maxMinutes}
                required
                onChange={(event) => setMaxMinutes(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="automation-tokens">最多 Token（可选）</Label>
              <Input
                id="automation-tokens"
                type="number"
                min={1}
                max={10000000}
                step={1}
                value={maxTokens}
                placeholder="不设限额"
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="automation-cost">最多费用（USD，可选）</Label>
              <Input
                id="automation-cost"
                type="number"
                min={0.000001}
                max={10000}
                step="any"
                value={maxCostUsd}
                placeholder="不设限额"
                onChange={(event) => setMaxCostUsd(event.target.value)}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">达到限额时暂停后续处理，保留已有成果。</p>
        </details>
        {create.error ? (
          <p role="alert" className="text-sm text-danger">
            {create.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" onClick={onClose} disabled={create.isPending}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "正在保存…" : "创建自动化"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AutomationTaskRow({ task }: { task: Task }) {
  const client = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelAutomationTask(task.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["automation-tasks"] }),
  });
  const status = task.automationStatus ?? task.status;
  const terminal = ["completed", "cancelled", "closed", "failed"].includes(status);
  return (
    <li className="flex flex-wrap items-center gap-3 border-t py-3 text-sm">
      <div className="min-w-0 flex-1">
        <Link
          to="/"
          search={{ c: task.conversationId }}
          className="block truncate font-medium hover:text-brand"
        >
          {task.title}
        </Link>
        <p className="mt-1 text-xs text-muted">{automationStatusLabel(status)}</p>
      </div>
      <Link
        to="/"
        search={{ c: task.conversationId }}
        className="rounded-lg px-2 py-2 text-xs text-brand hover:bg-surface-2"
      >
        查看会话与成果
      </Link>
      {!terminal ? (
        <div className="space-y-1">
          <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "正在请求停止…" : "停止任务及后续触发"}
          </Button>
          <p className="text-xs text-muted">将停用此自动化，保留已有会话与成果。</p>
        </div>
      ) : null}
      {status === "needs_attention" ? (
        <AutomationRecovery taskId={task.id} conversationId={task.conversationId} />
      ) : null}
      {cancel.error ? (
        <p role="alert" className="w-full text-xs text-danger">
          {cancel.error.message}
        </p>
      ) : null}
    </li>
  );
}

function AutomationItem({ binding }: { binding: AutomationBinding }) {
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const tasks = useQuery({
    queryKey: ["automation-tasks", binding.id],
    queryFn: () => api.automationTasks(binding.id),
    refetchInterval: 2500,
  });
  const latestTask = tasks.data?.[0];
  const daily = binding.schedule?.cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  const trigger = useMutation({
    mutationFn: async () => {
      const pending = preparePendingEvent(`trigger:${binding.id}`);
      await api.triggerAutomation(binding.id, pending.eventId);
      return pending;
    },
    onSuccess: (pending) => {
      clearPendingEvent(`trigger:${binding.id}`, pending.eventId);
      setExpanded(true);
      void client.invalidateQueries({ queryKey: ["automation-tasks", binding.id] });
      void client.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.disableAutomation(binding.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["automations"] }),
  });
  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-[220px]">
          <h2 className="break-words text-base font-semibold">{binding.title}</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
            {binding.goal}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={binding.enabled ? "brand" : "neutral"}>
              {binding.enabled ? "已启用" : "已停用"}
            </Badge>
            <Badge>
              {binding.schedule ? (
                <>
                  <CalendarClock className="h-3 w-3" />
                  定时 · {binding.schedule.timezone}
                </>
              ) : (
                "手动执行"
              )}
            </Badge>
          </div>
          {binding.schedule ? (
            <p className="mt-2 break-words text-xs text-muted">
              {daily
                ? `每天 ${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")} 自动执行`
                : `定时表达式：${binding.schedule.cron}`}
              。应用运行时到点自动开始，无需点击「立即运行」。
            </p>
          ) : null}
          <div className="mt-3 text-sm" role="status">
            {latestTask ? (
              <>
                <p>
                  最近运行：
                  {automationStatusLabel(latestTask.automationStatus ?? latestTask.status)}
                  <span className="ml-2 text-xs text-muted">
                    {new Date(latestTask.createdAt).toLocaleString()}
                  </span>
                </p>
                <Link
                  to="/"
                  search={{ c: latestTask.conversationId }}
                  className="mt-1 inline-block text-brand hover:underline"
                >
                  查看最新进度与成果
                </Link>
              </>
            ) : binding.enabled && binding.schedule && !tasks.isLoading ? (
              <p className="text-muted">等待计划时间自动执行</p>
            ) : null}
          </div>
        </div>
        <Button
          variant="primary"
          disabled={!binding.enabled || trigger.isPending}
          onClick={() => trigger.mutate()}
        >
          <Play className="h-3.5 w-3.5" />
          {trigger.isPending ? "正在提交…" : "立即运行"}
        </Button>
      </div>
      {trigger.error || disable.error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {trigger.error?.message ?? disable.error?.message}
        </p>
      ) : null}
      {trigger.isSuccess ? (
        <p role="status" className="mt-3 text-xs text-muted">
          任务已提交，可在下方查看进度。
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-10 items-center gap-1.5 text-xs text-muted hover:text-fg"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          运行记录
        </button>
        {binding.enabled ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disable.isPending}
            onClick={() => disable.mutate()}
          >
            {disable.isPending ? "正在停用…" : "停用后续触发"}
          </Button>
        ) : null}
      </div>
      <AnimatedDisclosure open={expanded}>
        <div>
          {tasks.isLoading ? <Spinner /> : null}
          {tasks.error ? (
            <p role="alert" className="text-sm text-danger">
              {tasks.error.message}
            </p>
          ) : null}
          {tasks.data?.length ? (
            <ul>
              {tasks.data.map((task) => (
                <AutomationTaskRow key={task.id} task={task} />
              ))}
            </ul>
          ) : tasks.data ? (
            <p className="border-t py-3 text-sm text-muted">还没有运行记录。</p>
          ) : null}
        </div>
      </AnimatedDisclosure>
    </Card>
  );
}

export function AutomationsPage() {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [query, setQuery] = useState("");
  const bindings = useQuery({ queryKey: ["automations"], queryFn: api.automations });
  const items = bindings.data ?? [];
  const visible = items.filter(
    (item) =>
      (filter === "all" || item.enabled === (filter === "enabled")) &&
      `${item.title} ${item.goal}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const status = useQuery({
    queryKey: ["autoloop-status"],
    queryFn: api.autoloopStatus,
    refetchInterval: 10000,
  });
  return (
    <PageSurface className="max-w-[1120px]">
      <PageHeader
        icon={<Repeat2 className="h-5 w-5" />}
        title="自动化"
        description="设定目标，让 Agent 持续推进。需要你决定时，在原会话中回答后继续。"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            新建自动化
          </Button>
        }
      />
      <PageMetrics
        items={[
          {
            label: "全部自动化",
            value: bindings.isLoading ? "—" : items.length,
            detail: "可复用的任务目标",
          },
          {
            label: "已启用",
            value: bindings.isLoading ? "—" : items.filter((item) => item.enabled).length,
            detail: "可接受新的触发",
          },
          {
            label: "定时执行",
            value: bindings.isLoading
              ? "—"
              : items.filter((item) => item.enabled && item.schedule).length,
            detail: "按计划自动开始",
          },
        ]}
      />
      <div className="ad-page-toolbar">
        <Segmented
          label="自动化筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "已停用" },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            aria-label="搜索自动化"
            placeholder="搜索名称或目标"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="bg-surface pl-8"
          />
        </div>
      </div>
      {status.data?.mode !== "disabled" && status.data && !status.data.available ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          自动化服务暂时不可用。已有任务与成果已保留，服务恢复后可继续。
        </p>
      ) : null}
      {bindings.isLoading ? <Spinner /> : null}
      {bindings.error ? (
        <p role="alert" className="text-sm text-danger">
          {bindings.error.message}
        </p>
      ) : null}
      {visible.length ? (
        <div className="space-y-4">
          <AnimatePresence initial={false}>
            {visible.map((binding) => (
              <motion.div
                key={binding.id}
                layout="position"
                variants={gridItemVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <AutomationItem binding={binding} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : bindings.data ? (
        <EmptyState
          icon={<Repeat2 className="h-6 w-6" />}
          title={items.length ? "没有匹配的自动化" : "把重复工作交给 Agent"}
          description={
            items.length
              ? "尝试其他关键词，或重置筛选查看全部自动化。"
              : "从整理项目资料、生成报告或制作 PPT 开始。你可以随时查看进度和已有成果。"
          }
          action={
            items.length ? (
              <Button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                重置筛选
              </Button>
            ) : (
              <Button onClick={() => setCreating(true)}>创建第一个自动化</Button>
            )
          }
        />
      ) : null}
      {creating ? <CreateAutomation onClose={() => setCreating(false)} /> : null}
    </PageSurface>
  );
}

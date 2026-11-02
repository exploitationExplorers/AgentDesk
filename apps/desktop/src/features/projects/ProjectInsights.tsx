import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, ExternalLink, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Project, ProjectInsight, ProjectInsightInput } from "@agentdesk/shared";
import { Badge, Button, Dialog, Field, Input, Select, Spinner, Textarea, cn } from "@agentdesk/ui";
import { timeAgo } from "../../lib/format";
import { projectInsightsApi } from "./project-insights-api";

const statusLabels = { analyzing: "分析中", ready: "已完成", failed: "分析失败" };
const suggestionLabels = { existing: "已有能力", partial: "可完善", new: "建议新增" };
const priorityLabels = { high: "高", medium: "中", low: "低" };
const effortLabels = { small: "小", medium: "中", large: "大" };

export function ProjectInsights({
  projects,
  initialProjectId,
  onClose,
}: {
  projects: Project[];
  initialProjectId?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const history = useQuery({
    queryKey: ["project-insights", projectId],
    queryFn: () => projectInsightsApi.list(projectId),
    enabled: !!projectId,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "analyzing") ? 2000 : false,
  });
  const record = history.data?.find((item) => item.id === recordId);
  const start = useMutation({
    mutationFn: (input: ProjectInsightInput) => projectInsightsApi.start(input),
    onSuccess: (result) => {
      client.setQueryData<ProjectInsight[]>(["project-insights", result.projectId], (old) => [
        result,
        ...(old ?? []).filter((item) => item.id !== result.id),
      ]);
      setRecordId(result.id);
      setSelected([]);
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const createTasks = useMutation({
    mutationFn: () => projectInsightsApi.createTasks(record!.id, selected),
    onSuccess: async () => {
      setSelected([]);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["project-insights", projectId] }),
        client.invalidateQueries({ queryKey: ["tasks"] }),
        client.invalidateQueries({ queryKey: ["conversations"] }),
      ]);
    },
  });
  const reset = () => {
    setRecordId(null);
    setSelected([]);
    start.reset();
    createTasks.reset();
  };
  const retry = (item: ProjectInsight) => {
    reset();
    setTitle(item.title);
    setSourceUrl(item.sourceUrl ?? "");
    setSourceText(item.sourceText);
  };
  const busy = start.isPending || createTasks.isPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="资料转改进"
      description="把文章或资料与项目代码对照，整理可执行的改进建议。"
      className="w-[min(1100px,95vw)]"
    >
      <div className="grid gap-4">
        <Field label="目标项目">
          <Select
            aria-label="资料分析目标项目"
            value={projectId}
            disabled={busy}
            onChange={(event) => {
              setProjectId(event.target.value);
              reset();
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid min-h-0 gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="space-y-3" aria-label="资料分析历史">
            <Button
              size="sm"
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => {
                reset();
                setTitle("");
                setSourceUrl("");
                setSourceText("");
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              新建分析
            </Button>
            <p className="text-xs text-subtle">分析保存在此，关闭后可继续查看。</p>
            {history.isLoading && <Spinner />}
            {history.error && (
              <p role="alert" className="text-xs text-danger">
                {history.error.message}
              </p>
            )}
            {(history.data ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecordId(item.id);
                  setSelected([]);
                  start.reset();
                  createTasks.reset();
                }}
                className={cn(
                  "w-full rounded-lg border p-3 text-left text-xs hover:bg-surface-2",
                  item.id === recordId && "border-brand bg-surface-2",
                )}
              >
                <span className="block truncate font-medium">{item.title}</span>
                <span className="mt-1 block text-subtle">
                  {statusLabels[item.status]} · {timeAgo(item.createdAt)}
                </span>
              </button>
            ))}
            {!history.isLoading && !history.error && history.data?.length === 0 && (
              <p className="text-xs text-subtle">还没有分析记录</p>
            )}
          </aside>
          <div className="min-w-0">
            {!record ? (
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  start.mutate({
                    projectId,
                    title: title.trim() || "资料分析",
                    sourceUrl: sourceUrl.trim() || undefined,
                    sourceText: sourceText.trim() || undefined,
                  });
                }}
              >
                <Field label="分析名称">
                  <Input
                    aria-label="分析名称"
                    placeholder="例如：文章中的产品改进方向"
                    value={title}
                    maxLength={200}
                    disabled={start.isPending}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Field>
                <Field label="资料链接" hint="支持公开文章；链接无法读取时，可直接粘贴正文。">
                  <Input
                    aria-label="资料链接"
                    type="url"
                    placeholder="https://…"
                    value={sourceUrl}
                    maxLength={4096}
                    disabled={start.isPending}
                    onChange={(event) => setSourceUrl(event.target.value)}
                  />
                </Field>
                <Field
                  label="资料正文"
                  hint="至少 30 字，最多 60,000 字；填写正文后优先分析正文，并保留链接作为来源。"
                >
                  <Textarea
                    aria-label="资料正文"
                    value={sourceText}
                    maxLength={60000}
                    rows={9}
                    disabled={start.isPending}
                    onChange={(event) => setSourceText(event.target.value)}
                    placeholder="粘贴文章正文或你想对照的资料…"
                  />
                </Field>
                {start.error && (
                  <p role="alert" className="text-xs leading-5 text-danger">
                    {start.error.message}。如果网页限制读取，请粘贴正文后重试。
                  </p>
                )}
                <p className="text-xs leading-5 text-subtle">
                  分析会读取部分项目文件，并记录实际检查范围。确认建议后可创建任务并执行。
                </p>
                <div>
                  <Button
                    type="submit"
                    loading={start.isPending}
                    disabled={
                      !projectId ||
                      (!sourceUrl.trim() && sourceText.trim().length < 30) ||
                      (!!sourceText.trim() && sourceText.trim().length < 30)
                    }
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    开始分析
                  </Button>
                </div>
              </form>
            ) : (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <BookOpen className="h-4 w-4 text-brand" />
                  <h3 className="text-sm font-semibold">{record.title}</h3>
                  <Badge
                    tone={
                      record.status === "failed"
                        ? "danger"
                        : record.status === "ready"
                          ? "success"
                          : "info"
                    }
                  >
                    {statusLabels[record.status]}
                  </Badge>
                </div>
                <div className="rounded-xl border bg-surface-2/40 p-3 text-xs leading-5">
                  <p className="font-medium">资料来源</p>
                  {record.sourceUrl ? (
                    <a
                      href={record.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 flex items-start gap-1 break-all text-brand"
                    >
                      <ExternalLink className="mt-1 h-3 w-3 shrink-0" />
                      {record.sourceUrl}
                    </a>
                  ) : (
                    <p className="text-muted">粘贴的资料正文</p>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted">查看原始资料</summary>
                    <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-muted">
                      {record.sourceText}
                    </pre>
                  </details>
                </div>
                {record.status === "analyzing" && (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-xl border p-4 text-sm"
                  >
                    <Spinner />
                    <p>
                      正在对照项目代码与资料…
                      <span className="mt-1 block text-xs text-muted">
                        可以关闭窗口，稍后从分析历史查看结果。
                      </span>
                    </p>
                  </div>
                )}
                {record.status === "failed" && (
                  <div
                    role="alert"
                    className="space-y-3 rounded-xl border border-danger/30 p-3 text-xs"
                  >
                    <p className="text-danger">{record.error ?? "分析失败"}</p>
                    <Button size="sm" variant="secondary" onClick={() => retry(record)}>
                      编辑资料并重试
                    </Button>
                  </div>
                )}
                {record.status === "ready" && (
                  <>
                    <p className="whitespace-pre-wrap text-sm leading-6">{record.summary}</p>
                    <details className="rounded-xl border p-3 text-xs">
                      <summary className="cursor-pointer font-medium">
                        本次检查了 {record.reviewedFiles.length} 个文件片段
                      </summary>
                      <p className="my-2 leading-5 text-muted">
                        建议基于下列文件片段；未覆盖的位置仍需核实。
                      </p>
                      <ul className="space-y-1 break-all font-mono text-muted">
                        {record.reviewedFiles.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                    <div className="space-y-3">
                      {record.suggestions.map((suggestion) => (
                        <article key={suggestion.id} className="rounded-xl border p-4 text-xs">
                          <label className="flex items-start gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={selected.includes(suggestion.id)}
                              disabled={!!suggestion.taskId || createTasks.isPending}
                              onChange={(event) =>
                                setSelected((items) =>
                                  event.target.checked
                                    ? [...items, suggestion.id]
                                    : items.filter((id) => id !== suggestion.id),
                                )
                              }
                            />
                            <span>{suggestion.title}</span>
                          </label>
                          <div className="my-3 flex flex-wrap gap-2">
                            <Badge>{suggestionLabels[suggestion.status]}</Badge>
                            <Badge tone={suggestion.priority === "high" ? "warning" : "neutral"}>
                              优先级：{priorityLabels[suggestion.priority]}
                            </Badge>
                            <Badge>工作量：{effortLabels[suggestion.effort]}</Badge>
                          </div>
                          <p className="whitespace-pre-wrap leading-5 text-muted">
                            {suggestion.rationale}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap leading-5">
                            {suggestion.proposal}
                          </p>
                          <blockquote className="mt-3 border-l-2 border-brand/40 pl-3 leading-5 text-muted">
                            {suggestion.sourceQuote}
                          </blockquote>
                          <div className="mt-3 space-y-1">
                            <h4 className="font-medium">代码依据</h4>
                            {suggestion.evidence.length ? (
                              suggestion.evidence.map((item, index) => (
                                <p key={index} className="break-words leading-5 text-muted">
                                  <code className="break-all">{item.path}</code>：{item.detail}
                                </p>
                              ))
                            ) : (
                              <p className="text-muted">暂无代码证据，执行前需核实。</p>
                            )}
                          </div>
                          <div className="mt-3">
                            <h4 className="font-medium">验收标准</h4>
                            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted">
                              {suggestion.acceptance.map((item, index) => (
                                <li key={index}>{item}</li>
                              ))}
                            </ul>
                          </div>
                          {suggestion.taskId && (
                            <Link
                              to="/code"
                              search={{ task: suggestion.taskId }}
                              className="mt-3 inline-block text-brand"
                            >
                              已创建任务 · 查看执行 →
                            </Link>
                          )}
                        </article>
                      ))}
                    </div>
                    {record.suggestions.length === 0 && (
                      <p className="text-sm text-muted">本次没有可执行的改进建议。</p>
                    )}
                    {createTasks.error && (
                      <p role="alert" className="text-xs text-danger">
                        {createTasks.error.message}
                      </p>
                    )}
                    {createTasks.isSuccess && (
                      <p role="status" className="text-xs text-success">
                        已创建 {createTasks.data.length} 个任务，可在对应建议中查看执行。
                      </p>
                    )}
                    <div className="sticky bottom-0 border-t bg-surface py-3">
                      <Button
                        loading={createTasks.isPending}
                        disabled={selected.length === 0 || createTasks.isPending}
                        onClick={() => createTasks.mutate()}
                      >
                        创建并运行所选任务（{selected.length}）
                      </Button>
                      <p className="mt-2 text-xs text-subtle">
                        每条建议生成独立任务，执行过程可在编码现场查看。
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

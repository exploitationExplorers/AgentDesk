import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Code2,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequest,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Terminal,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AiCommitPreview, GitPlatform, LaunchTarget, Project } from "@agentdesk/shared";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  Textarea,
  Tooltip,
  cn,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { compactNumber, timeAgo } from "../../lib/format";
import { toast } from "../../lib/toast";
import { useUi } from "../../stores/ui";

function StarBadge({ project }: { project: Project }) {
  if (project.stars == null) return null;
  if (project.platform !== "github" && project.platform !== "gitee") return null;
  const gained =
    project.prevStars != null && project.stars > project.prevStars
      ? project.stars - project.prevStars
      : 0;
  return (
    <Tooltip
      content={
        gained
          ? `自上次查看新增 ${gained} 个 Star（当前 ${project.stars}）`
          : `${project.platform === "github" ? "GitHub" : "Gitee"} 星标 ${project.stars}`
      }
      side="top"
    >
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium",
          gained ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted",
        )}
      >
        <Star className={cn("h-3 w-3", gained ? "fill-warning" : "")} />
        {compactNumber(project.stars)}
        {gained ? <span className="ml-0.5">+{gained}</span> : null}
      </span>
    </Tooltip>
  );
}

const PLATFORM: Record<GitPlatform, { label: string; className: string }> = {
  github: { label: "GitHub", className: "bg-[#24292f] text-white dark:bg-white dark:text-black" },
  gitee: { label: "Gitee", className: "bg-[#c71d23] text-white" },
  gitlab: { label: "GitLab", className: "bg-[#fc6d26] text-white" },
  unknown: { label: "Local", className: "bg-surface-2 text-muted" },
};

function PlatformTag({ platform }: { platform: GitPlatform }) {
  const p = PLATFORM[platform];
  return (
    <span className={cn("rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold", p.className)}>
      {p.label}
    </span>
  );
}

function LaunchButtons({ project, size = "sm" }: { project: Project; size?: "sm" | "md" }) {
  const launch = useMutation({
    mutationFn: (target: LaunchTarget) => api.launchProject(project.id, target),
  });
  const items: Array<{ target: LaunchTarget; label: string; icon: typeof Code2 }> = [
    { target: "cursor", label: "Cursor", icon: Code2 },
    { target: "claude", label: "Claude Code", icon: Bot },
    { target: "terminal", label: "终端", icon: Terminal },
    { target: "explorer", label: "文件夹", icon: FolderOpen },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map((i) =>
        size === "md" ? (
          <Button key={i.target} variant="secondary" onClick={() => launch.mutate(i.target)}>
            <i.icon className="h-3.5 w-3.5" />
            {i.label}
          </Button>
        ) : (
          <Tooltip key={i.target} content={`用 ${i.label} 打开`} side="top">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                launch.mutate(i.target);
              }}
              className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
              aria-label={i.label}
            >
              <i.icon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ),
      )}
    </div>
  );
}

function AiCommitDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [push, setPush] = useState(true);
  const [preview, setPreview] = useState<AiCommitPreview | null>(null);

  const load = useMutation({
    mutationFn: () => api.aiCommitPreview(project.id),
    onSuccess: (data) => {
      setPreview(data);
      setMessage(data.suggestedMessage);
      setStageAll(data.willStageAll || !data.hasStaged);
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api.aiCommit(project.id, {
        message: message.trim(),
        stageAll,
        push,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project-commits", project.id] });
      const details: string[] = [];
      if (result.commitHash) details.push(result.commitHash.slice(0, 7));
      if (result.pushed) details.push("已推送");
      toast(result.commitHash ? "提交成功" : result.pushed ? "推送成功" : "操作完成", {
        description: [project.name, ...details].join(" · "),
        tone: "success",
      });
      onOpenChange(false);
    },
  });
  const committing = commit.isPending;

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setMessage("");
      load.reset();
      commit.reset();
      return;
    }
    load.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在打开时拉预览
  }, [open, project.id]);

  const needsCommit = Boolean(preview && (preview.hasStaged || preview.hasUnstaged));
  const canSubmit =
    preview &&
    !load.isPending &&
    ((needsCommit && message.trim().length > 0) || (!needsCommit && preview.ahead > 0));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`AI 提交并推送 · ${project.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={committing}
            disabled={!canSubmit || committing}
            onClick={() => commit.mutate()}
          >
            <Upload className="h-3.5 w-3.5" />
            {committing ? "提交中…" : needsCommit ? (push ? "提交并推送" : "仅提交") : "推送到远程"}
          </Button>
        </>
      }
    >
      {load.isPending ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
          <Spinner />
          正在检测改动并用 AI 生成提交说明…
        </div>
      ) : load.error ? (
        <p className="text-[13px] text-danger">{load.error.message}</p>
      ) : preview ? (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {preview.branch ? <Badge>{preview.branch}</Badge> : null}
            {preview.stagedFiles.length ? (
              <Badge tone="brand">暂存 {preview.stagedFiles.length}</Badge>
            ) : null}
            {preview.unstagedFiles.length ? (
              <Badge tone="warning">未暂存 {preview.unstagedFiles.length}</Badge>
            ) : null}
            {preview.ahead ? <Badge tone="info">未推送 {preview.ahead}</Badge> : null}
          </div>

          {needsCommit ? (
            <Field
              label="提交说明"
              hint={
                preview.willStageAll
                  ? "暂存区为空，确认后会先 git add -A 再提交"
                  : "根据暂存区 / 工作区 diff 由 AI 生成，可直接改"
              }
            >
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="font-mono text-[12.5px]"
                autoFocus
              />
            </Field>
          ) : (
            <p className="text-[13px] text-muted">
              工作区干净，将把本地已有的 {preview.ahead} 个提交推送到远程。
            </p>
          )}

          <div className="flex flex-wrap gap-4 text-[12.5px] text-muted">
            {preview.willStageAll || preview.hasUnstaged ? (
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={stageAll}
                  onChange={(e) => setStageAll(e.target.checked)}
                  disabled={!preview.hasUnstaged}
                />
                暂存全部改动（git add -A）
              </label>
            ) : null}
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
              提交后推送到远程
            </label>
          </div>

          {preview.status ? (
            <pre className="max-h-28 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-muted">
              {preview.status}
            </pre>
          ) : null}
          {preview.diffPreview ? (
            <details>
              <summary className="cursor-pointer text-[12px] text-subtle">查看 diff 预览</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[10.5px] text-muted">
                {preview.diffPreview}
              </pre>
            </details>
          ) : null}
          {committing ? (
            <p className="flex items-center gap-2 text-[12.5px] text-muted">
              <Spinner className="h-3.5 w-3.5" />
              正在独立进程中执行 git commit / push（含 husky），请稍候…
            </p>
          ) : null}
          {commit.error ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11.5px] text-danger">
              {commit.error.message}
            </pre>
          ) : null}
          {commit.data ? (
            <p className="text-[12.5px] text-success">
              {commit.data.commitHash ? `已提交 ${commit.data.commitHash}` : "无需新提交"}
              {commit.data.pushed ? " · 已推送" : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function ProjectCard({
  project,
  onOpen,
  onAiCommit,
}: {
  project: Project;
  onOpen: () => void;
  onAiCommit: () => void;
}) {
  const highlight = project.dirtyFiles > 0 || project.ahead > 0;
  return (
    <Card
      className="group cursor-pointer p-4 transition-colors hover:border-border-strong"
      onClick={onOpen}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PlatformTag platform={project.platform} />
            <p className="truncate text-[14px] font-semibold">{project.name}</p>
            <StarBadge project={project} />
            {project.pinned ? <Pin className="h-3 w-3 text-brand" /> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-subtle">
            {project.owner ? `${project.owner}/${project.repo}` : project.path}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip content="AI 生成提交说明并推送" side="top">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAiCommit();
              }}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-lg hover:bg-brand/10",
                highlight ? "text-brand" : "text-muted hover:text-brand",
              )}
              aria-label="AI 提交推送"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <LaunchButtons project={project} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {project.branch ? <Badge>{project.branch}</Badge> : null}
        {project.dirtyFiles ? <Badge tone="warning">{project.dirtyFiles} 处改动</Badge> : null}
        {project.ahead ? (
          <Badge tone="info">
            <ArrowUp className="h-3 w-3" />
            {project.ahead} 未推送
          </Badge>
        ) : null}
        {project.behind ? (
          <Badge tone="danger">
            <ArrowDown className="h-3 w-3" />
            {project.behind} 待拉取
          </Badge>
        ) : null}
        {!project.dirtyFiles && !project.ahead && !project.behind ? (
          <Badge tone="success">干净</Badge>
        ) : null}
      </div>
      {project.lastCommit ? (
        <p className="mt-3 flex items-center gap-1.5 truncate text-[12px] text-muted">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="truncate">{project.lastCommit.message}</span>
          <span className="ml-auto shrink-0 text-[11px] text-subtle">
            {timeAgo(project.lastCommit.date)}
          </span>
        </p>
      ) : null}
    </Card>
  );
}

function ProjectDrawer({
  project,
  onClose,
  onAiCommit,
}: {
  project: Project;
  onClose: () => void;
  onAiCommit: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setChatPrefill = useUi((s) => s.setChatPrefill);
  const activity = useQuery({
    queryKey: ["project-activity", project.id],
    queryFn: () => api.projectActivity(project.id),
    retry: false,
  });
  const commits = useQuery({
    queryKey: ["project-commits", project.id],
    queryFn: () => api.projectCommits(project.id),
  });
  const sessions = useQuery({
    queryKey: ["claude-sessions", project.id],
    queryFn: () => api.claudeSessions(project.id),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["projects"] });
  const refresh = useMutation({
    mutationFn: () => api.refreshProject(project.id),
    onSuccess: invalidate,
  });
  const pull = useMutation({
    mutationFn: () => api.pullProject(project.id),
    onSuccess: invalidate,
  });
  const pin = useMutation({
    mutationFn: () => api.patchProject(project.id, { pinned: !project.pinned }),
    onSuccess: invalidate,
  });
  const webUrl =
    project.host && project.owner
      ? `https://${project.host}/${project.owner}/${project.repo}`
      : null;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={project.name} width={600}>
      <div className="grid gap-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <PlatformTag platform={project.platform} />
            <StarBadge project={project} />
            {project.branch ? <Badge>{project.branch}</Badge> : null}
            <span className="truncate font-mono text-[11.5px] text-subtle">{project.path}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <LaunchButtons project={project} size="md" />
            <Button variant="primary" onClick={onAiCommit}>
              <Sparkles className="h-3.5 w-3.5" />
              AI 提交推送
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新状态
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={pull.isPending}
              onClick={() => pull.mutate()}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              git pull
            </Button>
            <Button variant="ghost" size="sm" onClick={() => pin.mutate()}>
              <Pin className="h-3.5 w-3.5" />
              {project.pinned ? "取消置顶" : "置顶"}
            </Button>
            {webUrl ? (
              <Button variant="ghost" size="sm" asChild>
                <a href={webUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />在 {PLATFORM[project.platform].label} 查看
                </a>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChatPrefill({
                  message: `检查项目 ${project.name} 的状态和待处理的 PR/MR，给我下一步建议`,
                  agent: "project",
                });
                void navigate({ to: "/", search: {} });
              }}
            >
              <Bot className="h-3.5 w-3.5" />问 Bot
            </Button>
          </div>
          {pull.data ? (
            <pre className="mt-2 rounded-lg bg-surface-2 p-2 font-mono text-[11.5px] text-muted">
              {pull.data.output}
            </pre>
          ) : null}
          {pull.error ? <p className="mt-2 text-[12px] text-danger">{pull.error.message}</p> : null}
        </div>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
            <GitPullRequest className="h-4 w-4 text-muted" />
            {project.platform === "gitlab" ? "Merge Request" : "Pull Request"} 与 Issue
          </h3>
          {activity.isLoading ? (
            <Spinner />
          ) : activity.error ? (
            <div className="rounded-xl border border-warning/35 bg-warning/10 px-3 py-2.5 text-[12.5px] text-warning">
              <p>{activity.error.message}</p>
              <button
                type="button"
                className="mt-1.5 underline"
                onClick={() => void navigate({ to: "/settings", search: { tab: "git" } })}
              >
                去设置 → Git 平台
              </button>
            </div>
          ) : activity.data?.length ? (
            <div className="grid gap-1">
              {activity.data.map((a) => (
                <a
                  key={`${a.kind}-${a.number}`}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-surface-2"
                >
                  <Badge tone={a.kind === "issue" ? "neutral" : "brand"}>
                    {a.kind === "issue" ? "Issue" : a.kind === "merge_request" ? "MR" : "PR"}
                  </Badge>
                  <span className="text-subtle">#{a.number}</span>
                  <span className="truncate">{a.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-subtle">
                    {timeAgo(a.updatedAt)}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-subtle">没有开放的 PR/MR 或 Issue</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
            <GitCommitHorizontal className="h-4 w-4 text-muted" />
            最近提交
          </h3>
          <div className="grid gap-1">
            {(commits.data ?? []).map((c) => (
              <div key={c.hash} className="flex items-center gap-2 px-2 py-1 text-[12.5px]">
                <span className="font-mono text-[11px] text-subtle">{c.hash.slice(0, 7)}</span>
                <span className="truncate">{c.message}</span>
                <span className="ml-auto shrink-0 text-[11px] text-subtle">
                  {c.author} · {timeAgo(c.date)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
            <Bot className="h-4 w-4 text-muted" />
            Claude Code 会话
          </h3>
          {sessions.data?.length ? (
            <div className="grid gap-1">
              {sessions.data.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]"
                >
                  <span className="truncate">{s.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-subtle">
                    {s.messageCount} 条 · {timeAgo(s.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-subtle">这个项目还没有 Claude Code 会话</p>
          )}
        </section>
      </div>
    </Drawer>
  );
}

function AddProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"remote" | "path">("remote");
  const [platform, setPlatform] = useState<"github" | "gitee" | "gitlab">("gitee");
  const [repoId, setRepoId] = useState("");
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");

  const accounts = useQuery({ queryKey: ["git-accounts"], queryFn: api.gitAccounts });
  const hasToken = (accounts.data ?? []).some((a) => a.platform === platform && a.hasToken);

  const remotes = useQuery({
    queryKey: ["remote-repos", platform],
    queryFn: () => api.listRemoteRepos(platform),
    enabled: open && mode === "remote" && hasToken,
  });

  const filtered = useMemo(() => {
    const list = remotes.data ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }, [remotes.data, filter]);

  const selected = (remotes.data ?? []).find((r) => r.id === repoId);

  const importRemote = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("请选择仓库");
      return api.importRemoteRepo({
        platform,
        cloneUrl: selected.cloneUrl,
        fullName: selected.fullName,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["remote-repos", platform] });
      onOpenChange(false);
    },
  });

  const addPath = useMutation({
    mutationFn: () => api.addProject(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
    },
  });

  const busy = importRemote.isPending || addPath.isPending;
  const err = importRemote.error?.message || addPath.error?.message || remotes.error?.message;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加项目"
      footer={
        mode === "remote" ? (
          <Button
            variant="primary"
            loading={importRemote.isPending}
            onClick={() => importRemote.mutate()}
            disabled={!selected || selected.imported || !hasToken}
          >
            {selected?.localPath ? "关联本地仓库" : selected?.imported ? "已添加" : "导入"}
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={addPath.isPending}
            onClick={() => addPath.mutate()}
            disabled={!path}
          >
            添加
          </Button>
        )
      }
    >
      <div className="grid gap-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "remote", label: "从平台选择" },
            { value: "path", label: "本地路径" },
          ]}
        />

        {mode === "remote" ? (
          <>
            <Field label="平台">
              <Select
                value={platform}
                onChange={(e) => {
                  setPlatform(e.target.value as "github" | "gitee" | "gitlab");
                  setRepoId("");
                }}
              >
                <option value="gitee">Gitee</option>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </Select>
            </Field>

            {!hasToken ? (
              <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12.5px] text-warning">
                尚未配置 {platform} Token。
                <button
                  type="button"
                  className="ml-1 underline"
                  onClick={() => {
                    onOpenChange(false);
                    void navigate({ to: "/settings", search: { tab: "git" } });
                  }}
                >
                  去设置 → Git 平台
                </button>
                填写私人令牌后，即可下拉选择仓库。
              </div>
            ) : remotes.isLoading ? (
              <Spinner />
            ) : (
              <>
                <Field label="筛选仓库">
                  <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="按名称搜索…"
                    autoFocus
                  />
                </Field>
                <Field
                  label="选择仓库"
                  hint={
                    selected?.localPath
                      ? `将关联已有本地目录：${selected.localPath}`
                      : selected
                        ? "本地未找到克隆，将 clone 到第一个扫描目录"
                        : undefined
                  }
                >
                  <Select
                    value={repoId}
                    onChange={(e) => setRepoId(e.target.value)}
                    disabled={busy || !filtered.length}
                  >
                    <option value="">
                      {filtered.length ? `共 ${filtered.length} 个仓库…` : "没有可导入的仓库"}
                    </option>
                    {filtered.map((r) => (
                      <option key={r.id} value={r.id} disabled={r.imported}>
                        {r.fullName}
                        {r.private ? "（私有）" : ""}
                        {r.imported ? " · 已添加" : r.localPath ? " · 本地已有" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          </>
        ) : (
          <Field label="本地仓库路径">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:\\jiedan\\billiards-tribe\\manager_react"
              autoFocus
            />
          </Field>
        )}

        {err ? <p className="text-[12px] text-danger">{err}</p> : null}
      </div>
    </Dialog>
  );
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data = [], isLoading } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const sessions = useQuery({
    queryKey: ["claude-sessions", "all"],
    queryFn: () => api.claudeSessions(),
  });
  const [filter, setFilter] = useState<"all" | GitPlatform | "attention">("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [aiCommitId, setAiCommitId] = useState<string | null>(null);
  const scan = useMutation({
    mutationFn: api.scanProjects,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      // 扫描后 sidecar 会异步刷星标；稍后再拉一次列表
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }, 4_000);
    },
  });

  // 进入项目中心时后台刷新 GitHub/Gitee 星标
  useEffect(() => {
    let cancelled = false;
    void api
      .refreshProjectStars()
      .then((r) => {
        if (!cancelled && r.updated > 0) {
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
        }
      })
      .catch(() => {
        /* token 未配或网络失败时静默 */
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data.length, attention: 0 };
    for (const p of data) {
      c[p.platform] = (c[p.platform] ?? 0) + 1;
      if (p.dirtyFiles || p.ahead || p.behind) c.attention!++;
    }
    return c;
  }, [data]);

  const visible = data.filter((p) => {
    if (q && !`${p.name} ${p.owner ?? ""} ${p.path}`.toLowerCase().includes(q.toLowerCase()))
      return false;
    if (filter === "all") return true;
    if (filter === "attention") return p.dirtyFiles > 0 || p.ahead > 0 || p.behind > 0;
    return p.platform === filter;
  });
  const opened = data.find((p) => p.id === openId);
  const aiCommitProject = data.find((p) => p.id === aiCommitId);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          icon={<FolderGit2 className="h-5 w-5" />}
          title="项目中心"
          description="GitHub、Gitee、公司 GitLab 项目统一管理，一键在 Cursor 或 Claude Code 中打开"
          actions={
            <>
              <Button variant="ghost" onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
              <Button variant="primary" loading={scan.isPending} onClick={() => scan.mutate()}>
                <RefreshCw className="h-3.5 w-3.5" />
                扫描项目
              </Button>
            </>
          }
        />
        {scan.error ? (
          <div className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-warning">
            {scan.error.message}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => void navigate({ to: "/settings", search: { tab: "general" } })}
            >
              去设置
            </button>
          </div>
        ) : null}
        {scan.data ? (
          <p className="mb-4 text-[12.5px] text-muted">扫描完成：发现 {scan.data.found} 个仓库</p>
        ) : null}

        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `全部 ${counts.all}` },
              { value: "attention", label: `需关注 ${counts.attention}` },
              { value: "github", label: `GitHub ${counts.github ?? 0}` },
              { value: "gitee", label: `Gitee ${counts.gitee ?? 0}` },
              { value: "gitlab", label: `GitLab ${counts.gitlab ?? 0}` },
            ]}
          />
          <div className="relative ml-auto w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索项目"
              className="pl-8"
            />
          </div>
        </div>

        {isLoading ? (
          <Spinner />
        ) : visible.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() => setOpenId(p.id)}
                onAiCommit={() => setAiCommitId(p.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<FolderGit2 className="h-6 w-6" />}
            title={data.length ? "没有匹配的项目" : "还没有项目"}
            description="在 设置 > 通用 中添加扫描目录（例如 D:\agent），然后点击“扫描项目”。"
          />
        )}

        {sessions.data?.length ? (
          <section className="mt-10">
            <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
              <Bot className="h-4 w-4 text-muted" />
              最近的 Claude Code 会话
            </h2>
            <Card>
              {sessions.data.slice(0, 8).map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 border-b px-4 py-2.5 text-[12.5px] last:border-b-0"
                >
                  <span className="truncate">{s.title}</span>
                  <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-subtle">
                    {s.projectPath}
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">{timeAgo(s.updatedAt)}</span>
                </div>
              ))}
            </Card>
          </section>
        ) : null}
      </div>
      {opened ? (
        <ProjectDrawer
          project={opened}
          onClose={() => setOpenId(null)}
          onAiCommit={() => setAiCommitId(opened.id)}
        />
      ) : null}
      {adding ? <AddProjectDialog open onOpenChange={setAdding} /> : null}
      {aiCommitProject ? (
        <AiCommitDialog
          project={aiCommitProject}
          open
          onOpenChange={(o) => !o && setAiCommitId(null)}
        />
      ) : null}
    </div>
  );
}

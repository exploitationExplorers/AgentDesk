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
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { GitPlatform, LaunchTarget, Project } from "@agentdesk/shared";
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
  Spinner,
  Tooltip,
  cn,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useUi } from "../../stores/ui";

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

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
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
            {project.pinned ? <Pin className="h-3 w-3 text-brand" /> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-subtle">
            {project.owner ? `${project.owner}/${project.repo}` : project.path}
          </p>
        </div>
        <LaunchButtons project={project} />
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

function ProjectDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
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
            {project.branch ? <Badge>{project.branch}</Badge> : null}
            <span className="truncate font-mono text-[11.5px] text-subtle">{project.path}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <LaunchButtons project={project} size="md" />
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
            <p className="text-[12.5px] text-muted">
              {activity.error.message}（可在 设置 &gt; Git 平台 中配置 Token）
            </p>
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
  const [path, setPath] = useState("");
  const add = useMutation({
    mutationFn: () => api.addProject(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="手动添加项目"
      footer={
        <Button
          variant="primary"
          loading={add.isPending}
          onClick={() => add.mutate()}
          disabled={!path}
        >
          添加
        </Button>
      }
    >
      <Field label="本地仓库路径" hint={add.error?.message}>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="D:\\work\\im-server"
          autoFocus
        />
      </Field>
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
  const scan = useMutation({
    mutationFn: api.scanProjects,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

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
              <ProjectCard key={p.id} project={p} onOpen={() => setOpenId(p.id)} />
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
      {opened ? <ProjectDrawer project={opened} onClose={() => setOpenId(null)} /> : null}
      {adding ? <AddProjectDialog open onOpenChange={setAdding} /> : null}
    </div>
  );
}

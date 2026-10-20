import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  FolderGit2,
  GitBranch,
  Newspaper,
  Rocket,
  Sparkles,
  Telescope,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { compactNumber, greeting, todayLocal } from "../../lib/format";

const SUGGESTIONS: Array<{ icon: ReactNode; title: string; prompt: string; agent?: string }> = [
  {
    icon: <Newspaper className="h-4 w-4" />,
    title: "今日技术速览",
    prompt: "总结一下今天 GitHub 热榜和 HuggingFace 上最值得关注的 AI、前端、后端项目",
    agent: "research",
  },
  {
    icon: <GitBranch className="h-4 w-4" />,
    title: "项目巡检",
    prompt: "巡检我所有的项目：哪些有未提交改动、未推送提交或待处理的 PR/MR？",
    agent: "project",
  },
  {
    icon: <Rocket className="h-4 w-4" />,
    title: "部署 IM 后端",
    prompt: "帮我把 IM 项目部署到服务器",
    agent: "deploy",
  },
  {
    icon: <Telescope className="h-4 w-4" />,
    title: "深入讲解",
    prompt: "从今天的热榜里挑一个最值得我学习的 Agent 项目，深入讲解它的原理和用法",
    agent: "research",
  },
];

export function HomeHero({
  composer,
  onPick,
}: {
  composer: ReactNode;
  onPick: (prompt: string, agent?: string) => void;
}) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const digest = useQuery({
    queryKey: ["feed", "digest", todayLocal()],
    queryFn: () => api.digest(todayLocal()),
  });
  const feed = useQuery({
    queryKey: ["feed", "list", todayLocal(), "github"],
    queryFn: () => api.feed({ date: todayLocal(), source: "github" }),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const needAttention = (projects.data ?? []).filter(
    (p) => p.dirtyFiles > 0 || p.ahead > 0 || p.behind > 0,
  );

  return (
    <div className="ad-glow h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col px-6 pt-[12vh] pb-16">
        <div className="mb-8 text-center">
          <img
            src="/logo.svg"
            alt=""
            className="mx-auto mb-5 h-12 w-12 rounded-2xl shadow-[0_0_60px_-10px_var(--ad-brand)]"
          />
          <h1 className="text-[28px] font-semibold tracking-tight">{greeting()}，今天想做什么？</h1>
          <p className="mt-2 text-[13.5px] text-muted">
            管理项目、一键部署、追踪前沿技术，交给你的 Agent 团队。
          </p>
        </div>

        {providers.data && providers.data.length === 0 ? (
          <Link
            to="/settings"
            search={{ tab: "providers" }}
            className="mb-4 flex items-center gap-2 rounded-2xl border border-brand/40 bg-brand/10 px-4 py-3 text-[13px] text-fg hover:bg-brand/15"
          >
            <Sparkles className="h-4 w-4 text-brand" />
            还没有配置模型。从 CC Switch 或 .env 一键导入你的 Key
            <ArrowUpRight className="ml-auto h-4 w-4" />
          </Link>
        ) : null}

        {composer}

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onPick(s.prompt, s.agent)}
              className="group flex items-start gap-3 rounded-2xl border bg-surface/50 px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface"
            >
              <span className="mt-0.5 text-subtle group-hover:text-brand">{s.icon}</span>
              <span>
                <span className="block text-[13px] font-medium">{s.title}</span>
                <span className="mt-0.5 line-clamp-1 text-[12px] text-subtle">{s.prompt}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <Link
            to="/feed"
            className="rounded-2xl border bg-surface/60 p-4 transition-colors hover:border-border-strong"
          >
            <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-subtle">
              <Newspaper className="h-3.5 w-3.5" />
              今日热榜
              {digest.data ? <Badge tone="brand">已生成速览</Badge> : null}
            </div>
            {digest.data ? (
              <p className="mb-2 text-[13.5px] font-medium">{digest.data.headline}</p>
            ) : null}
            <ul className="grid gap-1.5">
              {(feed.data ?? []).slice(0, 4).map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-[12.5px]">
                  <span className="truncate text-muted">{item.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-subtle">
                    +{compactNumber(item.starsToday)}
                  </span>
                </li>
              ))}
              {feed.data?.length === 0 ? (
                <li className="text-[12.5px] text-subtle">今天还没有抓取，点击进入刷新</li>
              ) : null}
            </ul>
          </Link>
          <Link
            to="/projects"
            className="rounded-2xl border bg-surface/60 p-4 transition-colors hover:border-border-strong"
          >
            <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-subtle">
              <FolderGit2 className="h-3.5 w-3.5" />
              项目动态
            </div>
            <p className="text-[13.5px] font-medium">
              {projects.data?.length ?? 0} 个项目
              {needAttention.length ? (
                <span className="text-warning"> · {needAttention.length} 个需要关注</span>
              ) : null}
            </p>
            <ul className="mt-2 grid gap-1.5">
              {needAttention.slice(0, 3).map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-[12.5px] text-muted">
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-subtle">
                    {p.dirtyFiles ? `${p.dirtyFiles} 改动 ` : ""}
                    {p.ahead ? `↑${p.ahead} ` : ""}
                    {p.behind ? `↓${p.behind}` : ""}
                  </span>
                </li>
              ))}
              {projects.data?.length === 0 ? (
                <li className="text-[12.5px] text-subtle">在设置中配置扫描目录后自动发现</li>
              ) : null}
            </ul>
          </Link>
        </div>
      </div>
    </div>
  );
}

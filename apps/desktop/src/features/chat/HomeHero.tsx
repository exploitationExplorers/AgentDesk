import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FolderGit2, Newspaper, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Glass, GlassSurface, ShaderFlood, type ShaderFloodItem } from "@agentdesk/ui";
import { AppMark, useAppAvatar } from "../../components/AppMark";
import { api } from "../../lib/api";
import { compactNumber, greeting, todayLocal } from "../../lib/format";

function useLeiBoxTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const SUGGESTIONS: Array<{
  title: string;
  prompt: string;
  agent?: string;
  icon: NonNullable<ShaderFloodItem["icon"]>;
  colors: [string, string, string];
}> = [
  {
    title: "今日技术速览",
    prompt: "总结一下今天 GitHub 热榜和 HuggingFace 上最值得关注的 AI、前端、后端项目",
    agent: "research",
    icon: "layers",
    colors: ["#3a1a4a", "#d48c55", "#f4c164"],
  },
  {
    title: "项目巡检",
    prompt: "巡检我所有的项目：哪些有未提交改动、未推送提交或待处理的 PR/MR？",
    agent: "project",
    icon: "zap",
    colors: ["#0b2a5c", "#3b8cff", "#cfe4ff"],
  },
  {
    title: "部署 IM 后端",
    prompt: "帮我把 IM 项目部署到服务器",
    agent: "deploy",
    icon: "rocket",
    colors: ["#11280d", "#6fa85a", "#d7f0c8"],
  },
  {
    title: "深入讲解",
    prompt: "从今天的热榜里挑一个最值得我学习的 Agent 项目，深入讲解它的原理和用法",
    agent: "research",
    icon: "aperture",
    colors: ["#1d0b25", "#a34dff", "#ead9ff"],
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
  const avatar = useAppAvatar();
  const theme = useLeiBoxTheme();
  const needAttention = (projects.data ?? []).filter(
    (p) => p.dirtyFiles > 0 || p.ahead > 0 || p.behind > 0,
  );

  const floodOptions = useMemo(
    () => ({
      height: 448,
      theme,
      items: SUGGESTIONS.map((s) => ({
        title: s.title,
        description: s.prompt,
        icon: s.icon,
        colors: s.colors,
      })),
    }),
    [theme],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="chat-hero-in mx-auto flex w-full max-w-[820px] flex-col px-5 pt-10 pb-10 sm:px-9 sm:pt-[clamp(40px,11vh,120px)]">
        <Glass className="mb-8" size={64} depth={60} shine={0.35} zoom={1.12}>
          <div className="mb-6 flex items-center gap-2.5">
            <AppMark src={avatar} className="h-8 w-8 rounded-[11px]" />
            <span className="text-[12px] font-medium tracking-wide text-muted">
              你的 Agent 工作空间
            </span>
          </div>
          <h1
            data-glass-target
            className="text-[27px] font-semibold leading-snug tracking-tight sm:text-[34px]"
          >
            {greeting()}，<br className="sm:hidden" />
            今天想做什么？
          </h1>
          <p className="mt-3 text-[13px] leading-6 text-muted">
            从一个想法开始。查资料、写代码、推进项目，与你的 Agent 团队一起完成。
          </p>
        </Glass>

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

        <ShaderFlood
          className="mt-5"
          options={floodOptions}
          onItemSelect={(index) => {
            const s = SUGGESTIONS[index];
            if (s) onPick(s.prompt, s.agent);
          }}
        />

        <div className="mt-8 grid gap-4 border-t border-border/50 pt-6 md:grid-cols-2">
          <GlassSurface asChild>
            <Link to="/feed" className="rounded-2xl p-3.5 transition-colors hover:bg-surface/40">
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
          </GlassSurface>
          <GlassSurface asChild>
            <Link
              to="/projects"
              className="rounded-2xl p-3.5 transition-colors hover:bg-surface/40"
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
          </GlassSurface>
        </div>
      </div>
    </div>
  );
}

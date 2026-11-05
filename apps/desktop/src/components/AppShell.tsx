import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  FolderGit2,
  GraduationCap,
  Code2,
  HardDrive,
  MessageSquare,
  Menu,
  Moon,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Sun,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  StatusDot,
  Tooltip,
  TooltipProvider,
  cn,
  crossfadeVariants,
  motion,
} from "@agentdesk/ui";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../lib/api";
import { saveAvatar } from "../lib/avatar";
import { toast } from "../lib/toast";
import { applyTheme, isDarkTheme, toggleThemeWithTransition, useUi } from "../stores/ui";
import { AppMark, useAppAvatar } from "./AppMark";
import { LowDiskDialog } from "../features/disk/LowDiskDialog";
import { ApprovalToasts } from "./ApprovalToasts";
import { CommandPalette } from "./CommandPalette";
import { Toasts } from "./Toasts";

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/", label: "Bot", icon: MessageSquare },
  { to: "/code", label: "编码", icon: Code2 },
  { to: "/projects", label: "项目", icon: FolderGit2 },
  { to: "/deploy", label: "部署", icon: Rocket },
  { to: "/feed", label: "热榜", icon: Newspaper },
  { to: "/learning", label: "成长", icon: GraduationCap },
  { to: "/workflows", label: "工作流", icon: Workflow },
  { to: "/skills", label: "技能", icon: Sparkles },
  { to: "/disk", label: "磁盘", icon: HardDrive },
];

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  badge,
  alert,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
  badge?: number;
  alert?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
  const content = (
    <Link
      to={to}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
        active ? "text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg",
        collapsed && "justify-center px-0",
      )}
    >
      {active ? (
        <motion.span
          layoutId="nav-active-indicator"
          className="absolute inset-0 -z-10 rounded-lg bg-surface-2"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      ) : null}
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {badge ? (
        <span
          className={cn(
            "ml-auto rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black",
            collapsed && "absolute -right-0.5 -top-0.5 ml-0",
          )}
        >
          {badge}
        </span>
      ) : alert ? (
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full bg-warning",
            collapsed ? "absolute right-1 top-1" : "ml-auto",
          )}
        />
      ) : null}
    </Link>
  );
  return collapsed ? <Tooltip content={label}>{content}</Tooltip> : content;
}

export function AppShell() {
  useGlobalEvents();
  const { theme, sidebarCollapsed: collapsed, toggleSidebar, setPaletteOpen } = useUi();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const routeSection =
    useRouterState({ select: (s) => s.location.pathname }).split("/")[1] || "home";
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 30_000,
    retry: true,
  });
  const approvals = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
  });
  const pendingActions =
    approvals.data?.filter((approval) => approval.kind !== "question").length ?? 0;
  const pendingConversation = approvals.data?.find((approval) => approval.conversationId);
  const disk = useQuery({
    queryKey: ["disk-status"],
    queryFn: api.diskStatus,
    refetchInterval: 60_000,
    retry: false,
  });
  const avatar = useAppAvatar();
  const queryClient = useQueryClient();
  const avatarInput = useRef<HTMLInputElement>(null);
  const uploadAvatar = useMutation({
    mutationFn: saveAvatar,
    onSuccess: (next) => {
      queryClient.setQueryData(["settings"], next);
      toast("头像已更新", { tone: "success" });
    },
    onError: (error: Error) => toast(error.message || "头像更新失败", { tone: "danger" }),
  });

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => setMobileNavOpen(false), [routeSection]);

  const navCollapsed = (collapsed || routeSection === "home") && !mobileNavOpen;
  const dark = isDarkTheme(theme);

  const themeToggle = (
    <Tooltip content={dark ? "切换到浅色" : "切换到深色"}>
      <button
        type="button"
        className="grid h-9 w-9 place-items-center rounded-xl border border-border/80 bg-surface/90 text-muted shadow-sm backdrop-blur-md hover:bg-surface-2 hover:text-fg"
        onClick={(event) => toggleThemeWithTransition(event.nativeEvent)}
        aria-label="切换主题"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </Tooltip>
  );

  return (
    <TooltipProvider>
      <div className="relative flex h-full min-w-0 flex-col lg:flex-row">
        <div className="absolute right-3 top-3 z-40 hidden lg:block">{themeToggle}</div>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-surface px-3 lg:hidden">
          <button
            type="button"
            aria-label="打开主导航"
            title="主导航"
            onClick={() => setMobileNavOpen(true)}
            className="rounded-md p-2 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Menu className="h-4 w-4" />
          </button>
          <AppMark src={avatar} className="h-6 w-6" />
          <span className="text-sm font-semibold">AgentDesk</span>
          <div className="ml-auto">{themeToggle}</div>
        </div>
        {mobileNavOpen ? (
          <button
            type="button"
            aria-label="关闭主导航"
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-40 bg-fg/20 lg:hidden"
          />
        ) : null}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 shrink-0 flex-col border-r bg-surface px-2.5 py-3 shadow-xl lg:static lg:z-auto lg:flex lg:bg-surface/60 lg:shadow-none lg:transition-[width]",
            mobileNavOpen ? "flex w-[240px]" : "hidden",
            collapsed || routeSection === "home" ? "lg:w-[60px]" : "lg:w-[216px]",
          )}
        >
          <div
            className={cn(
              "mb-3 flex items-center gap-2 px-1.5",
              navCollapsed && "justify-center px-0",
            )}
          >
            <Tooltip content="更换头像">
              <button
                type="button"
                className="grid h-7 w-7 place-items-center overflow-hidden rounded-lg"
                aria-label="更换头像"
                onClick={() => avatarInput.current?.click()}
              >
                <AppMark src={avatar} className="h-7 w-7" />
              </button>
            </Tooltip>
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) uploadAvatar.mutate(file);
              }}
            />
            {navCollapsed ? null : (
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[14px] font-semibold tracking-tight">AgentDesk</p>
                <p className="truncate text-[11px] text-subtle">个人 Agent 工作台</p>
              </div>
            )}
            <div className={cn("flex shrink-0 items-center", navCollapsed && "flex-col gap-1")}>
              {routeSection !== "home" ? (
                <Tooltip content={navCollapsed ? "展开侧栏" : "收起侧栏"}>
                  <button
                    type="button"
                    className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                    onClick={toggleSidebar}
                    aria-label={navCollapsed ? "展开侧栏" : "收起侧栏"}
                  >
                    {navCollapsed ? (
                      <PanelLeftOpen className="h-4 w-4" />
                    ) : (
                      <PanelLeftClose className="h-4 w-4" />
                    )}
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip content="搜索或跳转">
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  aria-label="搜索或跳转"
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <Search className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5" onClick={() => setMobileNavOpen(false)}>
            {NAV.map((n) => (
              <NavItem
                key={n.to}
                {...n}
                collapsed={navCollapsed}
                alert={n.to === "/disk" && disk.data?.low === true}
              />
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-0.5">
            {pendingConversation ? (
              <Link
                to="/"
                search={{ c: pendingConversation.conversationId }}
                title="查看等待回复的对话"
                aria-label="查看等待回复的对话"
                className={cn(
                  "mb-2 flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2 text-xs text-brand",
                  navCollapsed && "justify-center px-0",
                )}
                onClick={() => setMobileNavOpen(false)}
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                {navCollapsed ? null : <span>有对话等待你的回复</span>}
              </Link>
            ) : pendingActions ? (
              <div
                className={cn(
                  "mb-2 flex items-center gap-2 rounded-xl bg-warning/10 px-2.5 py-2 text-[12px] text-warning",
                  navCollapsed && "justify-center px-0",
                )}
              >
                <ShieldAlert className="h-4 w-4 shrink-0" />
                {navCollapsed ? null : <span>{pendingActions} 个操作待审批</span>}
              </div>
            ) : null}
            <NavItem to="/settings" label="设置" icon={Settings} collapsed={navCollapsed} />
            <Tooltip
              content={
                health.data
                  ? `sidecar 运行中 · ${health.data.providers} 个模型 Provider`
                  : "正在连接 sidecar…"
              }
            >
              <span
                className={cn(
                  "mt-1 flex h-8 items-center gap-2 px-2.5 text-[11.5px] text-subtle",
                  navCollapsed && "justify-center px-0",
                )}
              >
                <StatusDot
                  status={health.data ? "success" : health.isError ? "error" : "running"}
                />
                {navCollapsed ? null : health.data ? `v${health.data.version}` : "连接中"}
              </span>
            </Tooltip>
          </div>
        </aside>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {/*
            路由层必须 absolute 叠放：若进出页都参与文档流，退出页在 opacity:0 时仍占满
            h-full，新页被挤到 overflow:hidden 视口外，看起来就像白屏，刷新才好。
            同时不用 mode="wait"，避免复杂页（Bot）exit 不收尾时主区一直空等。
          */}
          <AnimatePresence initial={false}>
            <motion.div
              key={routeSection}
              variants={crossfadeVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="absolute inset-0 h-full w-full"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <LowDiskDialog status={disk.data} />
      <CommandPalette />
      <Toasts />
      <ApprovalToasts />
    </TooltipProvider>
  );
}

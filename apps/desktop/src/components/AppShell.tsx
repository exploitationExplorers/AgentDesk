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
  Repeat2,
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
  StatusDot,
  Tooltip,
  TooltipProvider,
  cn,
  crossfadeVariants,
  motion,
  useReducedMotion,
  GlassSurface,
  GlassSelection,
  FluidRailTooltip,
  Button,
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
  { to: "/automations", label: "自动化", icon: Repeat2 },
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
  return (
    <Link
      to={to}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      data-fluid-tip={collapsed ? label : undefined}
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-xl px-2.5 text-[13px] font-medium transition-colors",
        active ? "text-brand" : "text-muted hover:bg-surface-2/70 hover:text-fg",
        collapsed && "justify-center px-0",
      )}
    >
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
}

export function AppShell() {
  useGlobalEvents();
  const reduced = useReducedMotion();
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
      <Button
        size="icon"
        type="button"
        className="h-9 w-9 rounded-xl text-muted"
        onClick={(event) => toggleThemeWithTransition(event.nativeEvent)}
        aria-label="切换主题"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
    </Tooltip>
  );

  return (
    <TooltipProvider>
      <div className="lb-app relative flex h-full min-w-0 flex-col lg:flex-row lg:gap-2 lg:p-2">
        <div className="absolute right-3 top-3 z-40 hidden lg:block">{themeToggle}</div>
        <div className="lb-glass flex h-12 shrink-0 items-center gap-2 border-b px-3 lg:hidden">
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
        <GlassSurface asChild>
          <aside
            className={cn(
              "lb-navigation fixed inset-y-2 left-2 z-50 shrink-0 flex-col overflow-visible px-2.5 py-3 lg:relative lg:z-20 lg:flex",
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

            <nav className="relative flex flex-col gap-0.5" onClick={() => setMobileNavOpen(false)}>
              <GlassSelection selector="[aria-current=page]" />
              {navCollapsed ? <FluidRailTooltip /> : null}
              {NAV.map((n) => (
                <NavItem
                  key={n.to}
                  {...n}
                  collapsed={navCollapsed}
                  alert={n.to === "/disk" && disk.data?.low === true}
                />
              ))}
            </nav>

            <div className="lb-navigation-footer relative mt-auto flex flex-col gap-0.5">
              <GlassSelection selector="[aria-current=page]" />
              {navCollapsed ? <FluidRailTooltip /> : null}
              {pendingConversation ? (
                <Link
                  to="/"
                  search={{ c: pendingConversation.conversationId }}
                  title="查看等待回复的对话"
                  aria-label="查看等待回复的对话"
                  data-fluid-tip={navCollapsed ? "等待回复" : undefined}
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
                  data-fluid-tip={navCollapsed ? `${pendingActions} 待审批` : undefined}
                >
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  {navCollapsed ? null : <span>{pendingActions} 个操作待审批</span>}
                </div>
              ) : null}
              <NavItem to="/settings" label="设置" icon={Settings} collapsed={navCollapsed} />
              {(() => {
                const healthLabel = health.data
                  ? `sidecar 运行中 · ${health.data.providers} 个模型 Provider`
                  : "正在连接 sidecar…";
                const healthNode = (
                  <span
                    className={cn(
                      "mt-1 flex h-8 items-center gap-2 px-2.5 text-[11.5px] text-subtle",
                      navCollapsed && "justify-center px-0",
                    )}
                    data-fluid-tip={navCollapsed ? healthLabel : undefined}
                  >
                    <StatusDot
                      status={health.data ? "success" : health.isError ? "error" : "running"}
                    />
                    {navCollapsed ? null : health.data ? `v${health.data.version}` : "连接中"}
                  </span>
                );
                return navCollapsed ? (
                  healthNode
                ) : (
                  <Tooltip content={healthLabel}>{healthNode}</Tooltip>
                );
              })()}
            </div>
          </aside>
        </GlassSurface>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* 保持 Outlet 的父节点稳定；路由 key 会在新匹配提交前重新挂载即将离开的页面。 */}
          <motion.div
            variants={reduced ? undefined : crossfadeVariants}
            initial="hidden"
            animate="visible"
            className="absolute inset-0 h-full w-full"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
      <LowDiskDialog status={disk.data} />
      <CommandPalette />
      <Toasts />
      <ApprovalToasts />
    </TooltipProvider>
  );
}

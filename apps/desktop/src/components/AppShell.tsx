import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  FolderGit2,
  HardDrive,
  MessageSquare,
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
import { useEffect, useRef } from "react";
import { Kbd, StatusDot, Tooltip, TooltipProvider, cn } from "@agentdesk/ui";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../lib/api";
import { saveAvatar } from "../lib/avatar";
import { toast } from "../lib/toast";
import { applyTheme, useUi } from "../stores/ui";
import { AppMark, useAppAvatar } from "./AppMark";
import { LowDiskDialog } from "../features/disk/LowDiskDialog";
import { ApprovalToasts } from "./ApprovalToasts";
import { CommandPalette } from "./CommandPalette";
import { Toasts } from "./Toasts";

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/", label: "Bot", icon: MessageSquare },
  { to: "/projects", label: "项目", icon: FolderGit2 },
  { to: "/deploy", label: "部署", icon: Rocket },
  { to: "/feed", label: "热榜", icon: Newspaper },
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
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-xl px-2.5 text-[13px] font-medium transition-colors",
        active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="h-[17px] w-[17px] shrink-0" />
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
  const { theme, setTheme, sidebarCollapsed: collapsed, toggleSidebar, setPaletteOpen } = useUi();
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

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r bg-surface/60 px-2.5 py-3 transition-[width]",
            collapsed ? "w-[60px]" : "w-[216px]",
          )}
        >
          <div
            className={cn(
              "mb-4 flex items-center gap-2.5 px-1.5",
              collapsed && "justify-center px-0",
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
            {collapsed ? null : (
              <div className="leading-tight">
                <p className="text-[14px] font-semibold tracking-tight">AgentDesk</p>
                <p className="text-[11px] text-subtle">个人 Agent 工作台</p>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cn(
              "mb-3 flex h-9 items-center gap-2 rounded-xl border bg-surface-2/60 px-2.5 text-[12.5px] text-subtle hover:text-muted",
              collapsed && "justify-center px-0",
            )}
          >
            <Search className="h-4 w-4" />
            {collapsed ? null : (
              <>
                <span className="flex-1 text-left">搜索或跳转</span>
                <Kbd>Ctrl K</Kbd>
              </>
            )}
          </button>

          <nav className="flex flex-col gap-0.5">
            {NAV.map((n) => (
              <NavItem
                key={n.to}
                {...n}
                collapsed={collapsed}
                alert={n.to === "/disk" && disk.data?.low === true}
              />
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-0.5">
            {approvals.data?.length ? (
              <div
                className={cn(
                  "mb-2 flex items-center gap-2 rounded-xl bg-warning/10 px-2.5 py-2 text-[12px] text-warning",
                  collapsed && "justify-center px-0",
                )}
              >
                <ShieldAlert className="h-4 w-4 shrink-0" />
                {collapsed ? null : <span>{approvals.data.length} 个操作待审批</span>}
              </div>
            ) : null}
            <NavItem to="/settings" label="设置" icon={Settings} collapsed={collapsed} />
            <div className={cn("mt-1 flex items-center gap-1 px-1", collapsed && "flex-col")}>
              <Tooltip
                content={
                  health.data
                    ? `sidecar 运行中 · ${health.data.providers} 个模型 Provider`
                    : "正在连接 sidecar…"
                }
              >
                <span className="flex h-8 flex-1 items-center gap-2 px-1.5 text-[11.5px] text-subtle">
                  <StatusDot
                    status={health.data ? "success" : health.isError ? "error" : "running"}
                  />
                  {collapsed ? null : health.data ? `v${health.data.version}` : "连接中"}
                </span>
              </Tooltip>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label="切换主题"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                onClick={toggleSidebar}
                aria-label="折叠侧栏"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <LowDiskDialog status={disk.data} />
      <CommandPalette />
      <Toasts />
      <ApprovalToasts />
    </TooltipProvider>
  );
}

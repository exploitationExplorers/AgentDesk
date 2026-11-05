import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light" | "system";

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** 其他页面跳到对话页时预填的问题，例如“让 Bot 讲解这个项目” */
  chatPrefill: { message: string; agent?: string } | null;
  setChatPrefill: (prefill: UiState["chatPrefill"]) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** @deprecated 已并入全局 theme；保留字段仅用于本地存储迁移 */
  chatLight?: boolean;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** 内嵌浏览器实况面板 */
  browserPanelOpen: boolean;
  activeBrowserSessionId: string | null;
  openBrowserPanel: (sessionId: string) => void;
  closeBrowserPanel: () => void;
  setBrowserPanelOpen: (open: boolean) => void;
  /** 低空间弹窗点「帮我看看」后，磁盘页接着开始扫描 */
  pendingDiskScan: boolean;
  setPendingDiskScan: (pending: boolean) => void;
  diskVolume: string | null;
  setDiskVolume: (volumePath: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      chatPrefill: null,
      setChatPrefill: (chatPrefill) => set({ chatPrefill }),
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      browserPanelOpen: false,
      activeBrowserSessionId: null,
      openBrowserPanel: (sessionId) =>
        set({ browserPanelOpen: true, activeBrowserSessionId: sessionId }),
      closeBrowserPanel: () => set({ browserPanelOpen: false }),
      setBrowserPanelOpen: (browserPanelOpen) => set({ browserPanelOpen }),
      pendingDiskScan: false,
      setPendingDiskScan: (pendingDiskScan) => set({ pendingDiskScan }),
      diskVolume: null,
      setDiskVolume: (diskVolume) => set({ diskVolume }),
    }),
    {
      name: "agentdesk-ui",
      partialize: (s) => ({
        theme: s.theme,
        sidebarCollapsed: s.sidebarCollapsed,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<UiState> & { chatLight?: boolean };
        // 旧版 Bot 页用 chatLight 强制浅色；迁移到全局 light，避免「点了没反应」的双轨状态。
        let theme = stored.theme ?? current.theme;
        if (stored.chatLight === true && (theme === "dark" || theme === "system")) {
          theme = "light";
        }
        return {
          ...current,
          ...stored,
          theme,
          chatLight: undefined,
        };
      },
    },
  ),
);

export function isDarkTheme(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", isDarkTheme(theme));
}

/** 在 dark / light 间切换（system 视为当前解析结果的对立面）。 */
export function nextTheme(theme: Theme): "dark" | "light" {
  return isDarkTheme(theme) ? "light" : "dark";
}

/**
 * 带圆形扩散的主题切换（View Transitions），交互参考 VitePress / 现代文档站。
 * 不支持或 prefer-reduced-motion 时直接切换。
 */
export function toggleThemeWithTransition(event?: { clientX: number; clientY: number }): void {
  const { theme, setTheme } = useUi.getState();
  const next = nextTheme(theme);
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canTransition =
    !reduced &&
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    typeof document.startViewTransition === "function";

  const apply = () => {
    setTheme(next);
    applyTheme(next);
  };

  if (!canTransition) {
    apply();
    return;
  }

  const x = event?.clientX ?? window.innerWidth / 2;
  const y = event?.clientY ?? window.innerHeight / 2;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  const transition = (
    document as Document & {
      startViewTransition: (cb: () => void) => { ready: Promise<void> };
    }
  ).startViewTransition(apply);
  void transition.ready.then(() => {
    document.documentElement.animate(
      {
        clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
      },
      {
        duration: 480,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        pseudoElement: "::view-transition-new(root)",
      },
    );
  });
}

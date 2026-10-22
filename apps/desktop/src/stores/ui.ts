import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light" | "system";

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** 其他页面跳到对话页时预填的问题，例如“让 Bot 讲解这个项目” */
  chatPrefill: { message: string; agent?: string } | null;
  setChatPrefill: (prefill: UiState["chatPrefill"]) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
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
    }),
    {
      name: "agentdesk-ui",
      partialize: (s) => ({ theme: s.theme, sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

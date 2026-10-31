export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isCliWorkbench = (): boolean => import.meta.env.VITE_AGENTDESK_MODE === "cli";

export interface SidecarInfo {
  url: string;
  token: string | null;
}

/** CLI 工作台同源访问，使用浏览器会话；Tauri 由 Rust 提供服务地址。 */
export async function getSidecarInfo(): Promise<SidecarInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (let attempt = 0; attempt < 60; attempt++) {
      const info = await invoke<SidecarInfo | null>("sidecar_info");
      if (info) return info;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("sidecar 启动超时");
  }
  if (isCliWorkbench()) {
    return { url: window.location.origin, token: null };
  }
  return {
    url: import.meta.env.VITE_SIDECAR_URL ?? "http://127.0.0.1:17890",
    token: import.meta.env.VITE_SIDECAR_TOKEN ?? null,
  };
}

export async function notify(title: string, body: string): Promise<void> {
  if (isTauri()) {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
    return;
  }
  if ("Notification" in window) {
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  }
}

export async function checkForUpdates(): Promise<string | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  await update.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return update.version;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LaunchTarget } from "@agentdesk/shared";
import { launchDetached } from "./exec";

export interface LaunchOptions {
  cursorCommand?: string;
  claudeCommand?: string;
}

const isWindows = process.platform === "win32";

function windowsTerminalPath(): string | null {
  const local = process.env.LOCALAPPDATA;
  const candidate = local ? join(local, "Microsoft", "WindowsApps", "wt.exe") : null;
  return candidate && existsSync(candidate) ? candidate : null;
}

/** 在新终端窗口中于 path 目录执行 command（为空则只打开终端）。 */
function openTerminal(path: string, command?: string): void {
  if (isWindows) {
    const wt = windowsTerminalPath();
    if (wt) {
      launchDetached(wt, command ? ["-d", path, "cmd", "/k", command] : ["-d", path]);
    } else {
      launchDetached("cmd.exe", [
        "/c",
        "start",
        "",
        "/D",
        path,
        "cmd",
        "/k",
        ...(command ? [command] : []),
      ]);
    }
    return;
  }
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script "cd '${path}'${command ? ` && ${command}` : ""}"`;
    launchDetached("osascript", ["-e", script]);
    return;
  }
  launchDetached("x-terminal-emulator", [
    "-e",
    `bash -c "cd '${path}'; ${command ?? ""}; exec bash"`,
  ]);
}

export function launchProject(
  target: LaunchTarget,
  path: string,
  options: LaunchOptions = {},
): void {
  if (!existsSync(path)) throw new Error(`目录不存在：${path}`);
  switch (target) {
    case "cursor": {
      const cmd = options.cursorCommand ?? "cursor";
      if (isWindows) launchDetached("cmd.exe", ["/c", cmd, path]);
      else launchDetached(cmd, [path]);
      return;
    }
    case "claude":
      openTerminal(path, options.claudeCommand ?? "claude");
      return;
    case "terminal":
      openTerminal(path);
      return;
    case "explorer":
      launchDetached(
        isWindows ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open",
        [path],
      );
      return;
  }
}

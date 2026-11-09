import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readConnector } from "./credentials.js";
import { serviceStatus, startService } from "../lifecycle.js";

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function connectorTaskName(home: string) {
  return `AgentDesk-Connector-${createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 16)}`;
}
export function connectorTaskXml(
  home: string,
  workerPath: string,
  sid: string,
  node = process.execPath,
) {
  if (!/^S-1-5-[0-9-]+$/.test(sid)) throw new Error("Invalid Windows SID");
  const cli = join(dirname(workerPath), "index.mjs");
  // 路径来自已安装 CLI 和用户数据目录，按 Windows argv 和 XML 两层分别转义。
  const quote = (value: string) =>
    '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="CurrentUser"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="CurrentUser"><Exec><Command>${escapeXml(node)}</Command><Arguments>${escapeXml(`${quote(cli)} connect monitor --data-dir ${quote(home)}`)}</Arguments><WorkingDirectory>${escapeXml(dirname(workerPath))}</WorkingDirectory></Exec></Actions>
</Task>`;
}
export function installConnectorAutostart(home: string, workerPath: string) {
  if (process.platform !== "win32") throw new Error("当前自启动安装仅支持 Windows。");
  if (!readConnector(home)?.enabled) throw new Error("请先完成电脑配对并启用连接。");
  const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw new Error("无法确认当前 Windows 用户。");
  const file = join(home, "connect", `autostart-${crypto.randomUUID()}.xml`);
  try {
    writeFileSync(file, "\uFEFF" + connectorTaskXml(home, workerPath, sid), {
      encoding: "utf16le",
      flag: "wx",
    });
    execFileSync("schtasks.exe", ["/Create", "/TN", connectorTaskName(home), "/XML", file, "/F"], {
      windowsHide: true,
      stdio: "pipe",
    });
    execFileSync("schtasks.exe", ["/Run", "/TN", connectorTaskName(home)], {
      windowsHide: true,
      stdio: "pipe",
    });
  } finally {
    rmSync(file, { force: true });
  }
}
export function uninstallConnectorAutostart(home: string) {
  if (process.platform !== "win32") throw new Error("当前自启动安装仅支持 Windows。");
  execFileSync("schtasks.exe", ["/Delete", "/TN", connectorTaskName(home), "/F"], {
    windowsHide: true,
    stdio: "pipe",
  });
}
/** 只恢复同一 CLI 实例；进程仍存活但未响应时不启动第二个调度器。 */
export async function monitorConnector(home: string, workerPath: string) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!abort.signal.aborted && readConnector(home)?.enabled) {
      try {
        if ((await serviceStatus(home)).status === "stopped")
          await startService(home, { workerPath });
      } catch {
        /* 暂时无法启动时保留状态，下次轮询再次检查实例。 */
      }
      await delay(30_000, undefined, { signal: abort.signal }).catch((error) => {
        if (!abort.signal.aborted) throw error;
      });
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

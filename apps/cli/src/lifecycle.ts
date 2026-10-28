import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { apiRequest, verifyInstance } from "./client.js";
import { createUi } from "./ui.js";
import type { CliState } from "./state.js";
import type { InstanceInfo } from "./client.js";
import {
  ensureHome,
  processAlive,
  readState,
  removeOwnedState,
  runtimeFileExists,
} from "./state.js";

type ServiceStatus =
  | { status: "stopped"; stale?: boolean; state?: CliState; instance?: undefined }
  | { status: "running"; state: CliState; instance: InstanceInfo }
  | { status: "starting" | "unreachable"; state: CliState; instance?: undefined };
interface StartOptions {
  workerPath: string;
  port?: number;
  foreground?: boolean;
}

export async function serviceStatus(home: string): Promise<ServiceStatus> {
  const state = readState(home);
  if (!state) return { status: "stopped" };
  if (!processAlive(state.pid)) return { status: "stopped", stale: true, state };
  try {
    const instance = await verifyInstance(state);
    return { status: "running", state, instance };
  } catch {
    return { status: state.port ? "unreachable" : "starting", state };
  }
}

/** 服务未运行时自动拉起（复用 startService 的启动与就绪轮询），而不是报错中断调用方。 */
export async function runningState(home: string, workerPath: string): Promise<CliState> {
  const result = await serviceStatus(home);
  if (result.status === "running") return result.state;
  const started = await createUi().task("检测到本地服务未运行，正在自动启动…", () =>
    startService(home, { workerPath }),
  );
  if (started.status !== "running") throw new Error("本地服务未就绪。");
  return started.state;
}

export async function startService(
  home: string,
  { workerPath, port, foreground = false }: StartOptions,
): Promise<ServiceStatus & { existing?: boolean }> {
  const current = await serviceStatus(home);
  if (current.status === "running") {
    if (port !== undefined && port > 0 && port !== current.state.port)
      throw new Error(
        `服务已在端口 ${current.state.port} 运行；要使用指定端口请执行 restart --port ${port}。`,
      );
    return { ...current, existing: true };
  }
  if (current.status !== "stopped") {
    throw new Error(`已有 CLI 进程正在启动或未响应（PID ${current.state.pid}），请先查看日志。`);
  }
  if (current.state) removeOwnedState(home, current.state.instanceId);
  runtimeFileExists(workerPath);
  ensureHome(home);
  const instanceId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const selectedPort = port ?? 17891;
  if (foreground) {
    const runtime = await import(pathToFileURL(workerPath).href);
    await runtime.runCliRuntime({
      home,
      instanceId,
      token,
      port: selectedPort,
      mode: "foreground",
    });
    return { status: "stopped" };
  }
  const logPath = join(home, "daemon.log");
  if (existsSync(logPath) && statSync(logPath).size > 10 * 1024 * 1024) {
    renameSync(logPath, `${logPath}.1`);
  }
  const logFd = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [workerPath], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        AGENTDESK_CLI_HOME: home,
        AGENTDESK_CLI_INSTANCE: instanceId,
        AGENTDESK_CLI_TOKEN: token,
        AGENTDESK_CLI_PORT: String(selectedPort),
      },
    });
  } finally {
    closeSync(logFd);
  }
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError;
    const result = await serviceStatus(home);
    if (result.status === "running")
      return { ...result, existing: result.state.instanceId !== instanceId };
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(125);
  }
  throw new Error(`CLI 服务未能就绪，请查看 ${logPath}。`);
}

export async function stopService(home: string) {
  const current = await serviceStatus(home);
  if (current.status === "stopped") {
    if (current.state) removeOwnedState(home, current.state.instanceId);
    return false;
  }
  if (current.status !== "running") {
    throw new Error("实例身份无法核实，已拒绝通过 PID 强制终止。请检查 agentdesk logs。");
  }
  await apiRequest(current.state, "/cli/shutdown", { method: "POST", body: "{}" });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = readState(home);
    if (!state || state.instanceId !== current.state.instanceId) return true;
    if (!processAlive(state.pid)) {
      removeOwnedState(home, state.instanceId);
      return true;
    }
    await delay(100);
  }
  throw new Error("服务仍在关闭，请稍后查看状态和日志。");
}

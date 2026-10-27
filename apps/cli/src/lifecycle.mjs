import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { apiRequest, verifyInstance } from "./client.mjs";
import { nextCommand } from "./ui.mjs";
import {
  ensureHome,
  processAlive,
  readState,
  removeOwnedState,
  runtimeFileExists,
} from "./state.mjs";

export async function serviceStatus(home) {
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

export async function runningState(home) {
  const result = await serviceStatus(home);
  if (result.status !== "running") {
    throw new Error(
      `CLI 服务尚未就绪（${result.status}）。请执行 ${nextCommand("start", home)}，或查看 ${nextCommand("logs", home)}。`,
    );
  }
  return result.state;
}

export async function startService(home, { workerPath, port, foreground = false } = {}) {
  const current = await serviceStatus(home);
  if (current.status === "running") {
    if (port > 0 && port !== current.state.port)
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
  let spawnError;
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

export async function stopService(home) {
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

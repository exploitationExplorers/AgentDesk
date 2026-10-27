import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function cliHome(directory, env = process.env) {
  return resolve(directory ?? env.AGENTDESK_CLI_HOME ?? join(homedir(), ".agentdesk"));
}

export function ensureHome(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function readState(home) {
  const file = join(home, "service.json");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`无法读取 CLI 实例状态：${file}。请检查文件权限和 JSON 格式。`);
  }
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0 ||
    !Number.isInteger(state.port) ||
    state.port < 0 ||
    state.port > 65535 ||
    typeof state.instanceId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(state.instanceId) ||
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token) ||
    !["foreground", "background"].includes(state.mode)
  )
    throw new Error(`CLI 实例状态格式无效：${file}`);
  return state;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export function removeOwnedState(home, instanceId) {
  const current = readState(home);
  if (current?.instanceId === instanceId) unlinkSync(join(home, "service.json"));
}

export function claimState(home, state) {
  ensureHome(home);
  const file = join(home, "service.json");
  const temp = join(home, `claim-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  try {
    // 原子建立排他链接，其他进程不会读到尚未写完的实例文件。
    linkSync(temp, file);
  } finally {
    unlinkSync(temp);
  }
}

export function runtimeFileExists(path) {
  if (!existsSync(path)) throw new Error("CLI 运行文件尚未生成，请先执行 pnpm build:cli。");
}

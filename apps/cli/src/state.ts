import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface CliState {
  schemaVersion: number;
  pid: number;
  port: number;
  instanceId: string;
  token: string;
  mode: "foreground" | "background";
  version: string;
  startedAt: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function cliHome(directory?: string, env = process.env) {
  return resolve(directory ?? env.AGENTDESK_CLI_HOME ?? join(homedir(), ".agentdesk"));
}

export function ensureHome(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function readState(home: string): CliState | null {
  const file = join(home, "service.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new Error(`无法读取 CLI 实例状态：${file}。请检查文件权限和 JSON 格式。`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`CLI 实例状态格式无效：${file}`);
  const state = parsed as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.pid !== "number" ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.port !== "number" ||
    !Number.isInteger(state.port) ||
    state.port < 0 ||
    state.port > 65535 ||
    typeof state.instanceId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(state.instanceId) ||
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token) ||
    (state.mode !== "foreground" && state.mode !== "background") ||
    typeof state.version !== "string" ||
    typeof state.startedAt !== "string"
  )
    throw new Error(`CLI 实例状态格式无效：${file}`);
  return {
    schemaVersion: state.schemaVersion,
    pid: state.pid,
    port: state.port,
    instanceId: state.instanceId,
    token: state.token,
    mode: state.mode,
    version: state.version,
    startedAt: state.startedAt,
  };
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    if (hasCode(error, "EPERM")) return true;
    throw error;
  }
}

export function removeOwnedState(home: string, instanceId: string) {
  const current = readState(home);
  if (current?.instanceId === instanceId) unlinkSync(join(home, "service.json"));
}

export function claimState(home: string, state: CliState) {
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

interface PublishStateOperations {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}

/**
 * 就绪状态仍通过同目录 rename 原子发布。Windows 的读轮询或杀毒软件可能短暂占用目标，
 * 只对共享冲突作有界退避；每次重试前重新核对实例，绝不删除目标绕过原子替换。
 */
export async function publishState(
  home: string,
  state: CliState,
  operations: PublishStateOperations = { platform: process.platform, rename, wait: delay },
): Promise<void> {
  const file = join(home, "service.json");
  const temp = join(home, `service-${randomUUID()}.tmp`);
  const retryDelays = [10, 20, 40, 80, 160, 250, 250];
  let failure: { error: unknown } | undefined;
  try {
    await writeFile(temp, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      const current = readState(home);
      if (
        current?.instanceId !== state.instanceId ||
        current.pid !== state.pid ||
        current.token !== state.token
      )
        throw new Error("CLI 实例所有权已改变，拒绝覆盖状态。");
      try {
        await operations.rename(temp, file);
        break;
      } catch (error) {
        const retryDelay = retryDelays[attempt];
        if (
          operations.platform !== "win32" ||
          retryDelay === undefined ||
          !["EPERM", "EACCES", "EBUSY"].some((code) => hasCode(error, code))
        )
          throw error;
        await operations.wait(retryDelay);
      }
    }
  } catch (error) {
    failure = { error };
  }
  try {
    await unlink(temp);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      if (failure)
        throw new AggregateError([failure.error, error], "状态发布失败，且无法清理临时文件。");
      throw error;
    }
  }
  if (failure) throw failure.error;
}

export function runtimeFileExists(path: string) {
  if (!existsSync(path)) throw new Error("CLI 运行文件尚未生成，请先执行 pnpm build:cli。");
}

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUi } from "./ui.js";
import { select } from "./terminal.js";

const CHECK_TTL_MS = 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org";

export function isNewerVersion(latest: string, current: string) {
  const parts = (value: string) =>
    value
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number(/^(\d+)/.exec(part)?.[1] ?? 0));
  const left = parts(latest);
  const right = parts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

function readText(file: string) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function remember(home: string, file: string, text: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, file), text, "utf8");
}

/** 有可提示的新版本时返回该版本号；网络失败、已是最新或用户选择忽略时返回 null。 */
export async function pendingUpdate({
  current,
  name,
  home,
  fetchImpl = fetch,
  now = Date.now,
}: {
  current: string;
  name: string;
  home: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const skipped = readText(join(home, "update-skip"));
  const cacheFile = join(home, "update-check.json");
  let cached: { latest?: string; checkedAt?: number } = {};
  try {
    cached = JSON.parse(readText(cacheFile) || "{}") as typeof cached;
  } catch {
    cached = {};
  }
  const fresh =
    typeof cached.latest === "string" &&
    typeof cached.checkedAt === "number" &&
    now() - cached.checkedAt < CHECK_TTL_MS;
  let latest = fresh ? cached.latest : undefined;
  if (!fresh) {
    try {
      const response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}/latest`, {
        signal: AbortSignal.timeout(3000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`registry ${response.status}`);
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+/.test(body.version)) return null;
      latest = body.version;
      remember(home, "update-check.json", JSON.stringify({ latest, checkedAt: now() }));
    } catch {
      latest = cached.latest;
    }
  }
  if (!latest || !isNewerVersion(latest, current) || latest === skipped) return null;
  return latest;
}

function installGlobal(name: string, latest: string) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest)
  )
    return false;
  const result = spawnSync(
    "npm",
    ["install", "-g", `${name}@${latest}`, "--registry", `${REGISTRY}/`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return result.status === 0;
}

function relaunch() {
  return new Promise<void>((resolve) => {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, AGENTDESK_SKIP_UPDATE: "1" },
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", () => {
      process.exitCode = 1;
      resolve();
    });
  });
}

/** 交互启动时提示更新。返回 true 表示已经拉起新版本进程，当前进程应结束。 */
export async function offerCliUpdate({
  current,
  name,
  home,
  command,
  bare,
  json,
  env = process.env,
}: {
  current: string;
  name: string;
  home: string;
  command: string;
  bare: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const interactive =
    Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && Boolean(process.stderr.isTTY);
  const watched = bare || command === "init" || command === "chat" || command === "run";
  if (
    !interactive ||
    !watched ||
    json ||
    env.CI ||
    env.AGENTDESK_SKIP_UPDATE ||
    env.AGENTDESK_NO_UPDATE
  )
    return false;
  const latest = await pendingUpdate({ current, name, home });
  if (!latest) return false;
  const ui = createUi();
  ui.note(`发现新版本 ${current} → ${latest}`);
  ui.note(`更新说明：https://www.npmjs.com/package/${name}/v/${latest}`);
  let choice = "skip";
  try {
    choice = await select("要更新 CLI 吗？", [
      { label: "立即更新", value: "update", hint: `npm install -g ${name}` },
      { label: "本次跳过", value: "skip", hint: "下次启动再提示" },
      { label: "在下一个版本前不再提示", value: "ignore", hint: `忽略 ${latest}` },
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "已取消配置。") return false;
    throw error;
  }
  if (choice === "ignore") {
    remember(home, "update-skip", latest);
    return false;
  }
  if (choice !== "update") return false;
  ui.note(`正在安装 ${name}@${latest}`);
  if (!installGlobal(name, latest)) {
    ui.error("更新没有完成，继续使用当前版本。");
    return false;
  }
  await relaunch();
  return true;
}

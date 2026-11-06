import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { ensurePrivateDirectory } from "./private-directory";

export const AUTOLOOP_COMMIT = "22312e16419fc9f542a58044cfbb76f4aec80623";
export const AUTOLOOP_NODE_VERSION = "24.11.1";

export interface AutoloopRuntimeOptions {
  dataDir: string;
  rules?: unknown;
  credentials: { owner: string; worker: string; source: string; channel?: string };
  workerName?: string;
  sourceName?: string;
  nodePath?: string;
  /** 用于打包资源和隔离测试；不是来自事件正文的用户输入。 */
  hostPath?: string;
  supervisorPath?: string;
  signal?: AbortSignal;
}

export interface AutoloopRuntime {
  baseUrl: string;
  processId: number;
  updateRules(rules: unknown): Promise<void>;
  cancelSession(session: string): Promise<void>;
  stop(): Promise<void>;
}

interface HostReply {
  type?: string;
  id?: string;
  port?: number;
  error?: string;
}

function resourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "autoloop", "host.mjs"),
    join(here, "host.mjs"),
    resolve(here, "../host.mjs"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("内置 Autoloop Hub 资源缺失，请重新安装 AgentDesk");
  return found;
}

function runtimePath(host: string, explicit?: string): string {
  if (explicit) return explicit;
  const packaged = join(dirname(host), process.platform === "win32" ? "node.exe" : "node");
  if (existsSync(packaged)) return packaged;
  // 发布包必须携带独立的固定版本运行时，不能误用 sidecar 的原生模块 ABI。
  if (existsSync(join(dirname(host), "runtime-manifest.json")))
    throw new Error("内置 Autoloop Node 运行时缺失");
  const development = join(
    dirname(host),
    ".runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (existsSync(development)) return development;
  return process.execPath;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "LC_ALL", "TZ"])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

/** 独立进程运行真实上游 Hub，凭据仅经私有启动文件进入后端。 */
export async function startAutoloopRuntime(
  options: AutoloopRuntimeOptions,
): Promise<AutoloopRuntime> {
  options.signal?.throwIfAborted();
  const dataDir = ensurePrivateDirectory(options.dataDir);
  const host = options.hostPath ?? resourcePath();
  const node = runtimePath(host, options.nodePath);
  const configFile = join(dataDir, `startup-${randomUUID()}.json`);
  for (const credential of Object.values(options.credentials)) {
    if (!credential || credential.length < 32) throw new Error("Autoloop 凭据至少需要 32 个字符");
  }
  writeFileSync(
    configFile,
    JSON.stringify({
      dataDir,
      rules: options.rules ?? {
        sources: { agentdesk: { name: "AgentDesk" } },
        agents: {
          agentdesk: { name: "AgentDesk", worker: "agentdesk", use: "agentdesk", access: "edit" },
        },
        rules: [],
      },
      credentials: options.credentials,
      workerName: options.workerName ?? "agentdesk",
      sourceName: options.sourceName ?? "agentdesk",
    }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const supervisor =
    options.supervisorPath ??
    [
      join(
        dirname(host),
        process.platform === "win32" ? "agentdesk-supervisor.exe" : "agentdesk-supervisor",
      ),
      resolve(
        dirname(host),
        "../../crates/agentdesk-supervisor/target/debug/agentdesk-supervisor.exe",
      ),
    ].find(existsSync);
  const command = supervisor ?? node;
  const args = ["--disable-warning=ExperimentalWarning", host, configFile];
  if (supervisor) args.unshift(node);
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment(),
    cwd: dirname(host),
  });
  let stopped: Promise<void> | undefined;
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const stop = (): Promise<void> => (stopped ??= stopChild(child));
  const abort = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    try {
      child.emit("message", JSON.parse(line) as HostReply);
    } catch {
      /* 上游正文不进入前端或连接状态。 */
    }
  });
  // 上游错误可能含目录或请求正文；只在后端受控 IPC 中返回可公开错误。
  child.stderr?.resume();
  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Autoloop Hub 已停止"));
    pending.clear();
  };
  child.stdin?.on("error", rejectPending);
  child.on("message", (value: HostReply) => {
    if (!value.id) return;
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(value.error));
    else waiter.resolve();
  });
  child.once("close", () => {
    lines.close();
    options.signal?.removeEventListener("abort", abort);
    rejectPending();
  });
  try {
    const port = await new Promise<number>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Autoloop Hub 启动超时"));
      }, 15_000);
      const onMessage = (message: HostReply) => {
        if (message.type === "ready" && message.port) {
          cleanup();
          resolveReady(message.port);
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(message.error ?? "Autoloop Hub 启动失败"));
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error("无法启动内置 Autoloop Hub"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onError);
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onError);
    });
    options.signal?.throwIfAborted();
    const requestHost = async (type: string, payload: Record<string, unknown>): Promise<void> => {
      if (stopped || !child.stdin?.writable || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Autoloop Hub 已停止");
      const id = randomUUID();
      const message = JSON.stringify({ type, id, ...payload }) + "\n";
      await new Promise<void>((resolveUpdate, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Autoloop 控制请求超时"));
        }, 10_000);
        pending.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolveUpdate();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin!.write(message, (error) => {
          if (error) {
            pending.get(id)?.reject(new Error("Autoloop Hub 连接已关闭"));
            pending.delete(id);
          }
        });
      });
    };
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      processId: child.pid!,
      updateRules: (rules) => requestHost("rules", { rules }),
      cancelSession: (session) => requestHost("cancel_session", { session }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    rmSync(configFile, { force: true });
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => child.kill(), 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.stdin?.end(JSON.stringify({ type: "stop" }) + "\n");
  });
}

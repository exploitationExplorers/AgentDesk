import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** 协议依据：codex-cli 0.167.0 的 app-server generate-ts 输出。升级需重新验证。 */
export const CODEX_VERSION = "0.167.0";
export type CodexNotification = { method: string; params: Record<string, unknown> };
export type CodexServerRequest = CodexNotification & { id: number | string };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexRpc {
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(event: CodexNotification) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private callbacks = 0;
  private readonly exited: Promise<void>;
  private closing?: Promise<void>;
  onRequest: (request: CodexServerRequest) => Promise<unknown> = async () => {
    throw new Error("Unsupported Codex request");
  };
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once("close", () => resolve()));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer += this.decoder.write(chunk);
        if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024)
          throw new Error("Codex protocol frame exceeds limit");
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
      } catch {
        this.fail(new Error("Invalid Codex protocol stream"));
        void this.close();
      }
    });
    // 诊断流不得进入手机事件、日志或错误回包，可能含认证内容。
    child.stderr.resume();
    child.on("error", () => this.fail(new Error("Codex app-server could not start")));
    child.on("close", () =>
      this.fail(new Error("Codex app-server disconnected; inspect the task before resuming")),
    );
    child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed")));
  }
  subscribe(handler: (event: CodexNotification) => void) {
    this.notifications.add(handler);
    return () => {
      this.notifications.delete(handler);
    };
  }
  onFailure(handler: (error: Error) => void) {
    this.failures.add(handler);
    return () => {
      this.failures.delete(handler);
    };
  }
  private write(value: unknown) {
    if (this.closed) throw new Error("Codex app-server is closed");
    const frame = JSON.stringify(value) + "\n";
    if (
      Buffer.byteLength(frame) > 2 * 1024 * 1024 ||
      this.child.stdin.writableLength > 2 * 1024 * 1024
    )
      throw new Error("Codex input queue exceeds limit");
    this.child.stdin.write(frame);
  }
  private receive(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid JSON-RPC message");
    const message = value as Record<string, unknown>;
    if (typeof message.method === "string") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params))
        throw new Error("Invalid notification parameters");
      const event = { method: message.method, params: message.params as Record<string, unknown> };
      if (message.id === undefined) {
        for (const listener of this.notifications) listener(event);
        return;
      }
      if (typeof message.id !== "string" && typeof message.id !== "number")
        throw new Error("Invalid request id");
      if (++this.callbacks > 16) throw new Error("Too many pending Codex requests");
      const id = message.id;
      void this.onRequest({ ...event, id })
        .then(
          (result) => {
            if (!this.closed) this.write({ id, result });
          },
          () => {
            if (!this.closed)
              this.write({
                id,
                error: { code: -32601, message: "Request not supported by this client" },
              });
          },
        )
        .catch(() => this.fail(new Error("Could not answer Codex request")))
        .finally(() => {
          this.callbacks--;
        });
      return;
    }
    if (typeof message.id !== "number") throw new Error("Invalid response id");
    const pending = this.pending.get(message.id);
    if (!pending) return; // 超时的旧响应不再关联到新请求。
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error("Codex rejected the protocol request"));
    else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(new Error("Codex response has no result"));
  }
  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed || this.pending.size >= 32)
      return Promise.reject(new Error("Codex protocol is unavailable or busy"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; its result requires reconciliation`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }
  close(): Promise<void> {
    return (this.closing ??= this.terminate());
  }
  private async terminate() {
    this.fail(new Error("Codex session stopped"));
    const pid = this.child.pid;
    if (!pid || this.child.exitCode !== null) return;
    if (process.platform === "win32")
      await new Promise<void>((resolve) =>
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 10_000 },
          () => resolve(),
        ),
      );
    else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex process did not exit after termination")),
            10_000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function openCodexAppServer(binary: string, home: string): Promise<CodexRpc> {
  const version = await new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      ["--version"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (error, stdout) =>
        error ? reject(new Error("Codex binary is unavailable")) : resolve(stdout.trim()),
    ),
  );
  if (version !== `codex-cli ${CODEX_VERSION}`)
    throw new Error(`Codex ${CODEX_VERSION} is required; installed version has not been validated`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const rpc = new CodexRpc(child);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "agentdesk_remote", title: "AgentDesk", version: "0.1.0" },
      capabilities: null,
    });
    rpc.notify("initialized");
    return rpc;
  } catch (error) {
    await rpc.close();
    throw error;
  }
}

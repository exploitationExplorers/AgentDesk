import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        signal: options.signal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? error?.message ?? "", code });
      },
    );
  });
}

/** 通过系统 shell 执行（用于用户配置的命令行），返回合并输出。 */
export function runShell(
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  } = {},
): Promise<ExecResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ stdout: "", stderr: "The operation was aborted", code: 1 });

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let failed = false;
    let termination: Promise<void> | undefined;
    const terminate = () => {
      failed = true;
      if (!termination && child.pid)
        termination = terminateShellTree(child.pid).catch((error: Error) => {
          stderr += error.message;
        });
    };
    const timer = setTimeout(terminate, options.timeoutMs ?? 10 * 60_000);
    timer.unref();
    options.signal?.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      options.onOutput?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      options.onOutput?.(s);
    });
    child.on("error", (err) => {
      failed = true;
      stderr += err.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", terminate);
      // 撤权后的任务必须等整棵进程树退出，才能释放工作区锁。
      void (async () => {
        if (termination) await termination;
        resolve({ stdout, stderr, code: failed ? 1 : (code ?? 1) });
      })();
    });
  });
}

async function terminateShellTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        (error) => {
          if (error && error.code !== 128) reject(error);
          else resolve();
        },
      );
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** 启动一个与本进程脱离的 GUI/终端程序。 */
export function launchDetached(command: string, args: string[], cwd?: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
  });
  child.on("error", () => {});
  child.unref();
}

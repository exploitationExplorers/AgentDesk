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
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10 * 60_000);
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
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, code: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
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

import { execFile, spawn } from "node:child_process";
import { AppError, ErrorCode } from "@agentdesk/shared";

export async function repositoryGit(
  cwd: string,
  args: string[],
  options: {
    index?: string;
    timeoutMs?: number;
    allowFailure?: boolean;
    config?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].includes(key))
      delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
  });
  const config = Object.entries(options.config ?? {});
  if (config.length) {
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "credential.interactive=false",
        "-c",
        "http.followRedirects=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let termination: Promise<void> | undefined;
    const terminate = () => {
      failed = true;
      if (!termination && child.pid) termination = terminateGitTree(child.pid);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(errors, chunk));
    child.on("error", () => {
      failed = true;
    });
    const timer = setTimeout(terminate, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    timer.unref();
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", terminate);
      void (async () => {
        // Do not release repository locks while the termination command is still running.
        if (termination) await termination;
        const code = failed ? -1 : (exitCode ?? -1);
        if (code !== 0 && !options.allowFailure) {
          // Git output can contain credential helpers, repository paths and remote secrets.
          reject(
            new AppError(
              ErrorCode.Conflict,
              `Git ${args[0] ?? "operation"} failed; inspect the host repository before retrying`,
              { gitCommand: args[0] ?? "unknown", gitExitCode: code },
            ),
          );
        } else
          resolve({
            code,
            stdout: Buffer.concat(output).toString("utf8"),
            stderr: Buffer.concat(errors).toString("utf8"),
          });
      })().catch(reject);
    });
  });
}

async function terminateGitTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        () => resolve(),
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

export async function gitValue(cwd: string, args: string[], index?: string): Promise<string> {
  return (await repositoryGit(cwd, args, { index })).stdout.trim();
}

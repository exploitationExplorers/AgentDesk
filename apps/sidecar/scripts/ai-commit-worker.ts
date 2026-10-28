/**
 * 独立进程执行 git commit/push，避免 husky/lint-staged 改源码时
 * 把正在跑的 sidecar（tsx watch）热重载掉，导致前端 Failed to fetch。
 *
 * 开发: tsx ai-commit-worker.ts <job.json 路径>；发行: node ai-commit-worker.mjs <job.json 路径>
 */
import { execFile, type ExecException } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const jobArgument = process.argv[2];
if (!jobArgument) {
  console.error("missing job path");
  process.exit(1);
}
const jobPath: string = jobArgument;

interface CommitJob {
  id: string;
  projectId: string;
  repoPath: string;
  message: string;
  needsCommit: boolean;
  stageAll: boolean;
  push: boolean;
  commitHash?: string;
  status: "running" | "done" | "error";
  error?: string;
  result?: {
    projectId: string;
    message: string;
    commitHash: string;
    pushed: boolean;
    pushOutput: string;
  };
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function readJob(): CommitJob {
  const job: unknown = JSON.parse(readFileSync(jobPath, "utf8"));
  if (
    typeof job !== "object" ||
    job === null ||
    !("id" in job) ||
    typeof job.id !== "string" ||
    !("projectId" in job) ||
    typeof job.projectId !== "string" ||
    !("repoPath" in job) ||
    typeof job.repoPath !== "string" ||
    !("message" in job) ||
    typeof job.message !== "string" ||
    !("needsCommit" in job) ||
    typeof job.needsCommit !== "boolean" ||
    !("stageAll" in job) ||
    typeof job.stageAll !== "boolean" ||
    !("push" in job) ||
    typeof job.push !== "boolean" ||
    !("status" in job) ||
    !["running", "done", "error"].includes(String(job.status)) ||
    ("commitHash" in job && typeof job.commitHash !== "string")
  )
    throw new Error("invalid commit job");
  return job as CommitJob;
}

function writeJob(patch: Partial<CommitJob>): void {
  const cur = readJob();
  writeFileSync(jobPath, JSON.stringify({ ...cur, ...patch }, null, 2));
}

async function git(cwd: string, args: string[], timeoutMs = 180_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as ExecException & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? err.message ?? String(error),
    };
  }
}

function formatError(result: GitResult, fallback: string): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!combined) return fallback;
  const lines = combined.split(/\r?\n/);
  const important = lines.filter((l) =>
    /✖|error|rejected|DENIED|fatal|subject may|type may|commitlint|FAILED|failed/i.test(l),
  );
  return (important.length ? important.slice(-20) : lines.slice(-30)).join("\n").slice(0, 2500);
}

try {
  const job = readJob();
  const cwd = job.repoPath;
  let commitHash = job.commitHash ?? "";
  let pushOutput = "";
  let pushed = false;

  if (job.needsCommit) {
    if (job.stageAll) {
      const add = await git(cwd, ["add", "-A"], 60_000);
      if (add.code !== 0) throw new Error(formatError(add, "git add 失败"));
    }
    const commit = await git(cwd, ["commit", "-m", job.message], 180_000);
    if (commit.code !== 0) throw new Error(formatError(commit, "git commit 失败"));
    const hash = await git(cwd, ["rev-parse", "--short", "HEAD"], 15_000);
    commitHash = hash.code === 0 ? hash.stdout.trim() : "ok";
  }

  if (job.push) {
    const push = await git(cwd, ["push"], 180_000);
    if (push.code !== 0) {
      throw new Error(
        commitHash
          ? `已提交 ${commitHash}，但推送失败：\n${formatError(push, "git push 失败")}`
          : formatError(push, "git push 失败"),
      );
    }
    pushOutput = (push.stdout.trim() || push.stderr.trim() || "push ok").slice(0, 4000);
    pushed = true;
  }

  writeJob({
    status: "done",
    result: {
      projectId: job.projectId,
      message: job.message,
      commitHash,
      pushed,
      pushOutput,
    },
  });
} catch (error) {
  writeJob({
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

/**
 * 独立进程执行 git commit/push，避免 husky/lint-staged 改源码时
 * 把正在跑的 sidecar（tsx watch）热重载掉，导致前端 Failed to fetch。
 *
 * 用法: node ai-commit-worker.mjs <job.json 路径>
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const jobPath = process.argv[2];
if (!jobPath) {
  console.error("missing job path");
  process.exit(1);
}

function readJob() {
  return JSON.parse(readFileSync(jobPath, "utf8"));
}

function writeJob(patch) {
  const cur = readJob();
  writeFileSync(jobPath, JSON.stringify({ ...cur, ...patch }, null, 2));
}

async function git(cwd, args, timeoutMs = 180_000) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error;
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? err.message ?? String(error),
    };
  }
}

function formatError(result, fallback) {
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

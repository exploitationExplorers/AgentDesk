import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CommitInfo, GitPlatform } from "@agentdesk/shared";
import { run } from "../exec";
import { parseRemote } from "./remote-url";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
]);

/** 在给定根目录下查找 Git 仓库（找到仓库后不再深入其子目录）。 */
export async function findRepositories(roots: string[], maxDepth = 4): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        .map((e) => walk(join(dir, e.name), depth + 1)),
    );
  };
  await Promise.all(roots.map((root) => walk(root, 0)));
  return [...new Set(found)].sort();
}

export interface RepoInspection {
  name: string;
  path: string;
  platform: GitPlatform;
  remoteUrl: string | null;
  host: string | null;
  owner: string | null;
  repo: string | null;
  branch: string | null;
  dirtyFiles: number;
  ahead: number;
  behind: number;
  lastCommit: CommitInfo | null;
}

const git = (path: string, ...args: string[]) =>
  run("git", ["-C", path, ...args], { timeoutMs: 15_000 });

export async function inspectRepository(
  path: string,
  gitlabHosts: string[] = [],
): Promise<RepoInspection> {
  const [remote, branch, status, counts, log] = await Promise.all([
    git(path, "remote", "get-url", "origin"),
    git(path, "rev-parse", "--abbrev-ref", "HEAD"),
    git(path, "status", "--porcelain"),
    git(path, "rev-list", "--left-right", "--count", "@{u}...HEAD"),
    git(path, "log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI"),
  ]);
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() : null;
  const parsed = remoteUrl ? parseRemote(remoteUrl, gitlabHosts) : null;
  const [behind, ahead] =
    counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  const [hash, message, author, date] = log.stdout.trim().split("\x1f");

  return {
    name: basename(path),
    path,
    platform: parsed?.platform ?? "unknown",
    remoteUrl,
    host: parsed?.host ?? null,
    owner: parsed?.owner ?? null,
    repo: parsed?.repo ?? null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirtyFiles: status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()).length : 0,
    ahead: ahead || 0,
    behind: behind || 0,
    lastCommit:
      log.code === 0 && hash
        ? { hash, message: message ?? "", author: author ?? "", date: date ?? "" }
        : null,
  };
}

export async function gitPull(path: string): Promise<string> {
  const result = await run("git", ["-C", path, "pull", "--ff-only"], { timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git pull 失败");
  return result.stdout.trim() || result.stderr.trim();
}

export async function gitLog(path: string, limit = 10): Promise<CommitInfo[]> {
  const result = await git(path, "log", `-${limit}`, "--format=%H%x1f%s%x1f%an%x1f%aI");
  if (result.code !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", message = "", author = "", date = ""] = line.split("\x1f");
      return { hash, message, author, date };
    });
}

export async function gitStatus(path: string): Promise<string> {
  const result = await git(path, "status", "--short", "--branch");
  return result.stdout.trim();
}

export interface GitChangeSummary {
  branch: string | null;
  status: string;
  stagedDiff: string;
  unstagedDiff: string;
  stagedFiles: string[];
  unstagedFiles: string[];
  hasStaged: boolean;
  hasUnstaged: boolean;
  ahead: number;
}

function porcelainFiles(status: string, staged: boolean): string[] {
  return status
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length >= 3 && !l.startsWith("##"))
    .filter((l) => {
      const x = l[0] ?? " ";
      const y = l[1] ?? " ";
      return staged ? x !== " " && x !== "?" : y !== " " || x === "?";
    })
    .map((l) => l.slice(3).trim());
}

/** 汇总暂存区 / 工作区变更，供 AI 写 commit message。 */
export async function gitChangeSummary(path: string): Promise<GitChangeSummary> {
  const [status, staged, unstaged, branch, counts] = await Promise.all([
    git(path, "status", "--short", "--branch"),
    git(path, "diff", "--cached", "--stat", "--patch", "--find-renames"),
    git(path, "diff", "--stat", "--patch", "--find-renames"),
    git(path, "rev-parse", "--abbrev-ref", "HEAD"),
    git(path, "rev-list", "--left-right", "--count", "@{u}...HEAD"),
  ]);
  const short = status.code === 0 ? status.stdout.trim() : "";
  const stagedDiff = staged.code === 0 ? staged.stdout.trim() : "";
  // 未跟踪文件不会出现在 git diff 里，补一份名称列表
  const untracked = short
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim());
  let unstagedDiff = unstaged.code === 0 ? unstaged.stdout.trim() : "";
  if (untracked.length) {
    unstagedDiff = [unstagedDiff, `Untracked files:\n${untracked.map((f) => `  ${f}`).join("\n")}`]
      .filter(Boolean)
      .join("\n\n");
  }
  const [, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    status: short,
    stagedDiff: stagedDiff.slice(0, 24_000),
    unstagedDiff: unstagedDiff.slice(0, 24_000),
    stagedFiles: porcelainFiles(short, true),
    unstagedFiles: porcelainFiles(short, false),
    hasStaged: stagedDiff.length > 0 || porcelainFiles(short, true).length > 0,
    hasUnstaged: unstagedDiff.length > 0 || porcelainFiles(short, false).length > 0,
    ahead: ahead || 0,
  };
}

export async function gitAddAll(path: string): Promise<void> {
  const result = await git(path, "add", "-A");
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git add 失败");
}

/** 把模型偶发输出的 JSON / 代码块收成一行 Conventional Commit subject。 */
export function normalizeCommitMessage(raw: string): string {
  let text = raw.trim();
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)```$/m.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const subject = obj.subject ?? obj.message ?? obj.commit ?? obj.title;
      if (typeof subject === "string" && subject.trim()) text = subject.trim();
    } catch {
      const m = /"subject"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text);
      if (m?.[1]) text = m[1].replace(/\\"/g, '"');
    }
  }

  text =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#")) ?? text;
  text = text.replace(/^['"`]+|['"`]+$/g, "").trim();
  return text.slice(0, 200);
}

function formatGitError(result: { stdout: string; stderr: string }, fallback: string): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!combined) return fallback;
  const lines = combined.split(/\r?\n/);
  const important = lines.filter((l) =>
    /✖|error|rejected|DENIED|fatal|subject may|type may|commitlint|FAILED|failed/i.test(l),
  );
  return (important.length ? important.slice(-20) : lines.slice(-30)).join("\n").slice(0, 2_500);
}

export async function gitCommit(path: string, message: string): Promise<string> {
  const normalized = normalizeCommitMessage(message);
  if (!normalized) throw new Error("提交说明为空");
  const result = await run("git", ["-C", path, "commit", "-m", normalized], {
    timeoutMs: 180_000,
  });
  if (result.code !== 0) throw new Error(formatGitError(result, "git commit 失败"));
  const hash = await git(path, "rev-parse", "--short", "HEAD");
  return hash.code === 0 ? hash.stdout.trim() : "ok";
}

export async function gitPush(path: string): Promise<string> {
  const result = await run("git", ["-C", path, "push"], { timeoutMs: 180_000 });
  if (result.code !== 0) throw new Error(formatGitError(result, "git push 失败"));
  return (result.stdout.trim() || result.stderr.trim() || "push ok").slice(0, 4_000);
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

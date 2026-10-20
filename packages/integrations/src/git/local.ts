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

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

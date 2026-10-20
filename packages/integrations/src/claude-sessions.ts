import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ClaudeSession } from "@agentdesk/shared";

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** Claude Code 把项目路径中的非字母数字字符替换成 "-" 作为目录名。 */
export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
      )
      .join(" ");
  }
  return "";
}

async function readSession(file: string, fallbackPath: string): Promise<ClaudeSession | null> {
  const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  const lines = raw.split("\n").filter(Boolean);
  let title = "";
  let summary = "";
  let cwd = fallbackPath;
  let count = 0;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.cwd === "string") cwd = entry.cwd;
    if (entry.type === "summary" && typeof entry.summary === "string") summary = entry.summary;
    if (entry.type === "user" || entry.type === "assistant") {
      count++;
      const message = entry.message as { content?: unknown } | undefined;
      if (!title && entry.type === "user") {
        const text = textFromContent(message?.content).trim();
        if (text && !text.startsWith("<")) title = text;
      }
    }
  }
  if (count === 0) return null;
  return {
    id: basename(file, ".jsonl"),
    projectPath: cwd,
    title: (summary || title || "(无标题会话)").slice(0, 120),
    messageCount: count,
    updatedAt: info.mtime.toISOString(),
  };
}

/** 列出 Claude Code 会话；传入 projectPath 时只看该项目。 */
export async function listClaudeSessions(
  projectPath?: string,
  limit = 30,
): Promise<ClaudeSession[]> {
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  if (projectPath) {
    const encoded = encodeClaudeProjectPath(projectPath).toLowerCase();
    dirs = dirs.filter((d) => d.toLowerCase() === encoded);
  }

  const files: Array<{ file: string; dir: string; mtime: number }> = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = (await readdir(join(root, dir))).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(root, dir, name);
      try {
        files.push({ file, dir, mtime: (await stat(file)).mtimeMs });
      } catch {
        // 文件在扫描过程中被删除
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const sessions: ClaudeSession[] = [];
  for (const { file } of files.slice(0, limit * 2)) {
    const session = await readSession(file, projectPath ?? "").catch(() => null);
    if (session) sessions.push(session);
    if (sessions.length >= limit) break;
  }
  return sessions;
}

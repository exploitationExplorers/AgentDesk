import { enrichCodexHistory } from "./codex-history";
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { record, text, timestamp, withDatabase } from "./record";
import {
  antigravitySessions,
  claudeDesktopSessions,
  grokSessions,
  geminiDesktopSessions,
} from "./desktop-sources";
import { listClaudeSessions } from "@agentdesk/integrations";
import type { HubRecord } from "@agentdesk/shared";
import type { Container } from "../../container";

type Fields = Record<string, unknown>;
async function directories(dir: string) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name));
}
async function prefix(file: string) {
  const fd = await open(file, "r");
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fd.close();
  }
}
function jsonLine(line: string): Fields | undefined {
  try {
    return JSON.parse(line) ?? undefined;
  } catch {
    return undefined;
  }
}
export async function codexSessions(root = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const file = join(root, "state_5.sqlite");
  if (!existsSync(file)) {
    const index = join(root, "session_index.jsonl");
    if (!existsSync(index)) return [];
    const rows = new Map<string, HubRecord>();
    for (const line of (await readFile(index, "utf8")).split("\n")) {
      const r = jsonLine(line);
      if (typeof r?.id === "string")
        rows.set(
          r.id,
          record("codex", r.id, {
            title: text(r.thread_name, 300),
            updatedAt: timestamp(r.updated_at),
          }),
        );
    }
    return [...rows.values()];
  }
  const threads = withDatabase(file, (db) => {
    const columns = new Set(
      (db.pragma("table_info(threads)") as { name: string }[]).map((c) => c.name),
    );
    const fields = [
      "id",
      "title",
      "name",
      "cwd",
      "git_branch",
      "first_user_message",
      "preview",
      "rollout_path",
      "updated_at_ms",
      "updated_at",
    ].filter((k) => columns.has(k));
    if (!fields.includes("id")) throw new Error("不支持的 Codex 索引格式");
    return (db.prepare(`SELECT ${fields.join(",")} FROM threads`).all() as Fields[]).map((r) => ({
      rollout: text(r.rollout_path, 4096),
      row: record("codex", String(r.id), {
        title: text(r.name || r.title, 300),
        directory: text(r.cwd, 4096),
        branch: text(r.git_branch, 500),
        prompt: text(r.first_user_message, 4000),
        summary: text(r.preview, 4000),
        updatedAt: timestamp(r.updated_at_ms || r.updated_at),
      }),
    }));
  });
  return enrichCodexHistory(root, threads);
}
function cursorUserDir() {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "Cursor", "User");
}
export async function cursorSessions(
  userDir = cursorUserDir(),
  projects = join(homedir(), ".cursor", "projects"),
) {
  const rows = new Map<string, HubRecord>();
  const hiddenComposers = new Set<string>();
  const search = join(userDir, "globalStorage", "conversation-search.db");
  if (existsSync(search))
    withDatabase(search, (db) => {
      const data = db
        .prepare(
          "SELECT c.id,c.title,c.branches,c.updated_at,substr(f.body,1,4000) AS body FROM conversations c LEFT JOIN conversation_fts f ON f.rowid=c.fts_rowid",
        )
        .all() as Fields[];
      for (const r of data)
        rows.set(
          String(r.id),
          record("cursor", String(r.id), {
            title: text(r.title, 300),
            branch: text(r.branches, 500),
            summary: text(r.body, 4000),
            updatedAt: timestamp(r.updated_at),
          }),
        );
    });
  const global = join(userDir, "globalStorage", "state.vscdb");
  if (existsSync(global))
    withDatabase(global, (db) => {
      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
          .get()
      )
        return;
      for (const row of db
        .prepare("SELECT composerId, isSubagent, value FROM composerHeaders")
        .iterate() as Iterable<{ composerId: string; isSubagent: number; value: string }>) {
        const c = jsonLine(row.value);
        if (!c) continue;
        if (c.isDraft || row.isSubagent) {
          hiddenComposers.add(row.composerId);
          continue;
        }
        const prev = rows.get(row.composerId);
        if (!prev && !c.name && !c.text && !c.subtitle) continue;
        const workspace = c.workspaceIdentifier as
          { uri?: { fsPath?: unknown; path?: unknown } } | undefined;
        const directory = text(workspace?.uri?.fsPath || workspace?.uri?.path, 4096);
        rows.set(
          row.composerId,
          record("cursor", row.composerId, {
            ...prev,
            title: text(c.name, 300) || prev?.title,
            directory: isAbsolute(directory) ? directory : prev?.directory,
            prompt: text(c.text, 4000) || prev?.prompt,
            summary: prev?.summary || text(c.subtitle, 4000),
            updatedAt: Math.max(prev?.updatedAt || 0, timestamp(c.lastUpdatedAt || c.createdAt)),
          }),
        );
      }
    });
  for (const dir of await directories(join(userDir, "workspaceStorage"))) {
    const file = join(dir, "state.vscdb");
    if (!existsSync(file)) continue;
    const workspace = await readFile(join(dir, "workspace.json"), "utf8")
      .then(jsonLine)
      .catch(() => undefined);
    let directory = "";
    if (typeof workspace?.folder === "string" && workspace.folder.startsWith("file:"))
      directory = fileURLToPath(workspace.folder);
    const meta = withDatabase(
      file,
      (db) =>
        db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as
          { value: string } | undefined,
    );
    if (!meta) continue;
    const composers = jsonLine(meta.value)?.allComposers;
    if (!Array.isArray(composers)) continue;
    for (const c of composers) {
      if (!c?.composerId || c.isDraft || c.isSubagent || (!c.name && !rows.has(c.composerId)))
        continue;
      const prev = rows.get(c.composerId);
      rows.set(
        c.composerId,
        record("cursor", c.composerId, {
          ...prev,
          title: c.name || prev?.title,
          directory: directory || prev?.directory,
          updatedAt: Math.max(prev?.updatedAt || 0, timestamp(c.lastUpdatedAt || c.createdAt)),
        }),
      );
    }
  }
  for (const dir of await directories(projects)) {
    const folder = join(dir, "agent-transcripts");
    if (!existsSync(folder)) continue;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const id = entry.isDirectory() ? entry.name : basename(entry.name, ".jsonl");
      const file = entry.isDirectory() ? join(folder, id, `${id}.jsonl`) : join(folder, entry.name);
      if ((!entry.isDirectory() && !entry.name.endsWith(".jsonl")) || !existsSync(file)) continue;
      const prev = rows.get(id);
      const lines = (await prefix(file)).split("\n").map(jsonLine);
      const user = lines.find((r) => r?.role === "user");
      const msg = user?.message as { content?: Array<{ text?: string }> } | undefined;
      const envelope = Array.isArray(msg?.content)
        ? msg.content.map((c) => c.text || "").join(" ")
        : "";
      const prompt = (envelope.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? envelope)
        .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, " ")
        .trim();
      if (prev || prompt)
        rows.set(
          id,
          record("cursor", id, {
            ...prev,
            prompt: prompt || prev?.prompt,
            updatedAt: Math.max(prev?.updatedAt || 0, (await stat(file)).mtime.getTime()),
          }),
        );
    }
  }
  return [...rows.values()]
    .filter((row) => !hiddenComposers.has(row.id))
    .map((row) => {
      if (row.title === row.id) row.title = text(row.prompt || row.summary || row.id, 300);
      return row;
    });
}
export async function geminiSessions(root = join(homedir(), ".gemini", "tmp")) {
  const rows: HubRecord[] = [];
  for (const dir of await directories(root)) {
    const chats = join(dir, "chats");
    if (!existsSync(chats)) continue;
    for (const name of await readdir(chats)) {
      if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
      const data = jsonLine(await readFile(join(chats, name), "utf8"));
      if (typeof data?.sessionId !== "string" || !Array.isArray(data.messages)) continue;
      const msg = data.messages.find((m) => m.type === "user")?.content;
      rows.push(
        record("gemini", data.sessionId, {
          prompt:
            typeof msg === "string"
              ? msg
              : Array.isArray(msg)
                ? msg.map((part) => part.text || "").join(" ")
                : "",
          summary: text(data.summary, 4000),
          updatedAt: timestamp(data.lastUpdated || data.startTime),
        }),
      );
    }
  }
  return rows;
}
export function sessionSources({ chat, dbHandle }: Pick<Container, "chat" | "dbHandle">) {
  return {
    "claude-desktop": claudeDesktopSessions,
    "gemini-desktop": geminiDesktopSessions,
    grok: grokSessions,
    antigravity: antigravitySessions,
    codex: codexSessions,
    cursor: cursorSessions,
    gemini: geminiSessions,
    claude: async () =>
      (await listClaudeSessions(undefined, Infinity)).map((c) =>
        record("claude", c.id, {
          title: c.title,
          directory: c.projectPath,
          updatedAt: timestamp(c.updatedAt),
        }),
      ),
    agentdesk: async () => {
      const body = dbHandle.raw.prepare(
        "SELECT substr(content,1,4000) AS content FROM messages WHERE conversation_id=? AND role=? ORDER BY created_at LIMIT 1",
      );
      return chat.listConversations({ archived: "all" }).map((c) =>
        record("agentdesk", c.id, {
          title: c.title,
          prompt: (body.get(c.id, "user") as { content: string } | undefined)?.content,
          updatedAt: timestamp(c.updatedAt),
        }),
      );
    },
  };
}

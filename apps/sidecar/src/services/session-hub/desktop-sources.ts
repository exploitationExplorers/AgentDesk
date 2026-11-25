import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubRecord } from "@agentdesk/shared";
import { record, text, timestamp, withDatabase } from "./record";

async function* files(dir: string, depth: number): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isFile()) yield file;
    else if (entry.isDirectory() && depth > 0) yield* files(file, depth - 1);
  }
}
export async function claudeDesktopSessions(
  root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
) {
  const sessions: HubRecord[] = [];
  for await (const file of files(root, 4)) {
    if (!/[/\\]local_[^/\\]+\.json$/.test(file)) continue;
    let data;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (typeof data?.sessionId !== "string") continue;
    const row = record("claude-desktop", data.sessionId, {
      title: data.title,
      directory: data.originCwd,
      branch: data.writtenBranches?.[0],
      summary: data.postTurnSummary?.status_detail,
      updatedAt: timestamp(data.lastActivityAt || data.createdAt),
    });
    const numbers = Array.isArray(data.prs)
      ? data.prs
          .map((p: { prNumber?: unknown }) => Number(p?.prNumber))
          .filter((n: number) => Number.isInteger(n) && n > 0 && n <= 999999999)
      : [];
    row.prs = [...new Set<number>([...row.prs, ...numbers])].slice(0, 64);
    sessions.push(row);
  }
  return sessions;
}
export async function antigravitySessions(root = join(homedir(), ".gemini")) {
  const rows = new Map<string, HubRecord>();
  for (const dir of ["antigravity", "antigravity-cli"]) {
    const file = join(root, dir, "conversation_summaries.db");
    if (!existsSync(file)) continue;
    withDatabase(file, (db) => {
      const hasText = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='conversations_fts'")
        .get();
      const messages = hasText
        ? db.prepare(
            "SELECT substr(user_body,1,4000) AS prompt, substr(agent_body,1,4000) AS summary FROM conversations_fts WHERE conversation_id=? LIMIT 1",
          )
        : undefined;
      for (const item of db
        .prepare(
          "SELECT conversation_id,title,preview,workspace_uris,last_modified_time FROM conversation_summaries",
        )
        .iterate() as Iterable<Record<string, string>>) {
        const id = item.conversation_id;
        if (!id) continue;
        const context = messages?.get(id) as { prompt: string; summary: string } | undefined;
        let directory = "";
        try {
          const [uri] = JSON.parse(item.workspace_uris || "[]");
          if (uri?.startsWith("file:")) directory = fileURLToPath(uri);
        } catch {
          /* Older records may omit the workspace. */
        }
        const row = record("antigravity", id, {
          title: item.title,
          directory,
          prompt: context?.prompt,
          summary: item.preview || context?.summary,
          updatedAt: timestamp(item.last_modified_time),
        });
        if (!rows.has(id) || rows.get(id)!.updatedAt < row.updatedAt) rows.set(id, row);
      }
    });
  }
  return [...rows.values()];
}
export async function geminiDesktopSessions(
  root = join(homedir(), "Library", "Caches", "com.google.GeminiMacOS", "Gemini"),
) {
  const rows = new Map<string, HubRecord>();
  for await (const file of files(root, 1)) {
    if (!file.endsWith("/ChatInfo2.store")) continue;
    withDatabase(file, (db) => {
      for (const r of db
        .prepare(
          "SELECT ZROBINCONVERSATIONID AS id,ZLASTUPDATEDTIME AS modified FROM ZCHATINFOSTOREDMODEL WHERE ZROBINCONVERSATIONID <> ''",
        )
        .iterate() as Iterable<{ id: string; modified: number }>)
        rows.set(
          r.id,
          record("gemini-desktop", r.id, {
            title: r.id,
            updatedAt: timestamp(r.modified + 978307200),
          }),
        );
    });
  }
  return [...rows.values()];
}
export async function grokSessions(
  root = join(homedir(), "Library", "Application Support", "Grok Bot", "sand-client-persistence"),
) {
  const rows = new Map<string, HubRecord>();
  for await (const file of files(root, 0)) {
    if (!file.endsWith(".blob")) continue;
    // Only roster blobs contain the sidebar's rows. Skip transcripts and other caches.
    const name = file.split(/[/\\]/).pop()!.slice(0, -5).toUpperCase();
    let bits = 0,
      buffer = 0,
      decoded = "";
    for (const c of name) {
      const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
      if (digit < 0) break;
      buffer = (buffer << 5) | digit;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        decoded += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    if (!decoded.endsWith(".roster.last-roster")) continue;
    const roster = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(roster?.value?.rows)) continue;
    for (const r of roster.value.rows) {
      if (typeof r?.id !== "string" || r.isRemovedFromSidebar) continue;
      rows.set(
        r.id,
        record("grok", r.id, {
          title: text(r.title || r.name, 300),
          summary: r.description,
          directory: r.path,
          updatedAt: timestamp(r.lastActivityAt || r.updatedAt || r.createdAt),
        }),
      );
    }
  }
  return [...rows.values()];
}

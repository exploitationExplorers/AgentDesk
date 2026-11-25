import Database from "better-sqlite3";
import type { HubRecord, HubTool } from "@agentdesk/shared";
export const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
export function timestamp(v: unknown) {
  const n = typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
export function record(tool: HubTool, id: string, fields: Partial<HubRecord>): HubRecord {
  const prompt = text(fields.prompt, 4000),
    summary = text(fields.summary, 4000);
  const title = text(fields.title || prompt.split("\n")[0] || id, 300);
  const branch = text(fields.branch, 500);
  const matches = `${title}\n${prompt}\n${summary}\n${branch}`.matchAll(
    /(?:\/pull\/|\bPR\s*#?)([1-9]\d{0,8})\b/gi,
  );
  return {
    tool,
    id,
    title,
    prompt,
    summary,
    branch,
    directory: text(fields.directory, 4096),
    updatedAt: fields.updatedAt || 0,
    prs: [...new Set(Array.from(matches, (m) => Number(m[1])))].slice(0, 64),
  };
}
export function withDatabase<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

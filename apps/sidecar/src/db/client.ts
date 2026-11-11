import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { join } from "node:path";
import * as schema from "./schema";
import { migrateRemoteDatabase } from "./remote-migrations";
import { migrateMemoryDatabase } from "./memory-migrations";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close: () => void;
}

export function openDatabase(dataDir: string | ":memory:"): DbHandle {
  const raw = new Database(dataDir === ":memory:" ? ":memory:" : join(dataDir, "agentdesk.db"));
  try {
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.exec(schema.BOOTSTRAP_SQL);
    raw.exec(`CREATE TABLE IF NOT EXISTS event_retention (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pruned_through INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS event_retention_task_idx ON event_retention(task_id);`);
    const runColumns = raw.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "execution_owner"))
      raw.exec("ALTER TABLE runs ADD COLUMN execution_owner TEXT NOT NULL DEFAULT 'local'");
    migrateRemoteDatabase(raw);
    migrateMemoryDatabase(raw);
    return { db: drizzle(raw, { schema }), raw, close: () => raw.close() };
  } catch (error) {
    raw.close();
    throw error;
  }
}

/** 只读打开外部 sqlite 文件（用于导入 CC Switch 配置）。 */
export function readExternalSqlite(path: string, sql: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

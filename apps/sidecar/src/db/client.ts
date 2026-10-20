import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { join } from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close: () => void;
}

export function openDatabase(dataDir: string | ":memory:"): DbHandle {
  const raw = new Database(dataDir === ":memory:" ? ":memory:" : join(dataDir, "agentdesk.db"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(schema.BOOTSTRAP_SQL);
  return { db: drizzle(raw, { schema }), raw, close: () => raw.close() };
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

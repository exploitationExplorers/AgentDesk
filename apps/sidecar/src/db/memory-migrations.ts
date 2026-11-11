import type Database from "better-sqlite3";

/** 保留原有正文与 FTS 行号，为旧库增加治理元数据。 */
export function migrateMemoryDatabase(raw: Database.Database): void {
  raw.transaction(() => {
    const columns = new Set(
      (raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const additions = {
      scope: "TEXT NOT NULL DEFAULT 'user'",
      status: "TEXT NOT NULL DEFAULT 'active'",
      workspace: "TEXT",
      evidence: "TEXT",
      supersedes_id: "TEXT",
      expires_at: "TEXT",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) raw.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
    if (!columns.has("status")) {
      // 旧自动抽取未经过审核，迁移后必须进入候选状态。
      raw.exec("UPDATE memories SET status = 'candidate' WHERE source = 'auto'");
    }
    raw.exec(`
      CREATE TABLE IF NOT EXISTS memory_controls (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_tombstones (
        namespace TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (namespace, digest)
      );
      CREATE INDEX IF NOT EXISTS memories_status_idx ON memories(namespace, status, updated_at);
    `);
  })();
}

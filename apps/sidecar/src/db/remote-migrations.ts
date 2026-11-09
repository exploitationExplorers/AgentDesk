import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const migrations = [
  {
    version: 4,
    sql: `
    CREATE TABLE cloud_repository_imports(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,status TEXT NOT NULL,project_id TEXT,created_at TEXT NOT NULL,error_code TEXT);
  `,
  },
  {
    version: 3,
    sql: `
    CREATE TABLE codex_threads(task_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL UNIQUE);
    CREATE TABLE codex_turns(run_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,status TEXT NOT NULL);
  `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE workspace_snapshots (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,host_id TEXT NOT NULL,
        project_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,
        manifest_json TEXT,created_at INTEGER NOT NULL,UNIQUE(user_id,host_id,project_id,request_id));
      CREATE TABLE workspace_transfers (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,host_id TEXT NOT NULL,
        project_id TEXT NOT NULL,request_id TEXT NOT NULL,manifest_json TEXT NOT NULL,manifest_hash TEXT NOT NULL,
        status TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL,UNIQUE(user_id,host_id,project_id,request_id));
    `,
  },
  {
    version: 1,
    sql: `
    CREATE TABLE remote_operations (
      operation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, action TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
      status TEXT NOT NULL CHECK(status IN ('accepted','running','succeeded','failed','cancel_requested','cancelled','needs_reconciliation')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, host_id, project_id, action, request_id)
    );
    CREATE INDEX remote_operations_scope_idx ON remote_operations(user_id, host_id, project_id, created_at);
    CREATE TABLE remote_project_grants (
      user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
      connection_epoch INTEGER NOT NULL CHECK(connection_epoch > 0),
      expires_at TEXT NOT NULL, revoked_at TEXT,
      PRIMARY KEY(user_id, host_id, project_id, workspace_id)
    );
    CREATE TABLE remote_task_contexts (
      task_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE REFERENCES remote_operations(operation_id),
      user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, recent_auth_at TEXT NOT NULL,
      executor TEXT NOT NULL CHECK(executor IN ('native-bot','codex')),
      connection_epoch INTEGER NOT NULL CHECK(connection_epoch > 0), lease_expires_at TEXT NOT NULL
    );
    CREATE INDEX remote_task_contexts_scope_idx ON remote_task_contexts(user_id, host_id, project_id);
    CREATE TABLE remote_approval_contexts (
      approval_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES remote_operations(operation_id),
      task_id TEXT REFERENCES remote_task_contexts(task_id),
      user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      action TEXT NOT NULL, action_digest TEXT NOT NULL CHECK(length(action_digest) = 64),
      version INTEGER NOT NULL CHECK(version > 0), expires_at TEXT NOT NULL,
      resolved_by TEXT, decision INTEGER CHECK(decision IN (0,1)),
      CHECK((resolved_by IS NULL AND decision IS NULL) OR (resolved_by IS NOT NULL AND decision IS NOT NULL))
    );
    CREATE TABLE remote_audit_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      action TEXT NOT NULL, request_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      outcome TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX remote_audit_scope_idx ON remote_audit_events(user_id, host_id, project_id, seq);
    CREATE TABLE task_submissions (
      request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
      task_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL
    );
  `,
  },
].sort((a, b) => a.version - b.version);

/** 独立前向版本表：旧库只追加远程能力，不改 execution_owner 的含义。 */
export function migrateRemoteDatabase(raw: Database.Database): void {
  raw
    .transaction(() => {
      raw.exec(`CREATE TABLE IF NOT EXISTS remote_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
      const applied = raw
        .prepare("SELECT version, checksum FROM remote_schema_migrations ORDER BY version")
        .all() as Array<{ version: number; checksum: string }>;
      for (const row of applied) {
        const migration = migrations.find((item) => item.version === row.version);
        if (!migration || createHash("sha256").update(migration.sql).digest("hex") !== row.checksum)
          throw new Error(
            "Remote database schema is newer than this build or its migration was modified",
          );
      }
      for (const migration of migrations) {
        if (applied.some((row) => row.version === migration.version)) continue;
        raw.exec(migration.sql);
        raw
          .prepare(
            "INSERT INTO remote_schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(
            migration.version,
            createHash("sha256").update(migration.sql).digest("hex"),
            new Date().toISOString(),
          );
      }
    })
    .immediate();
}

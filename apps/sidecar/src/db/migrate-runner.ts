import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { PostgresUnitOfWork } from "./postgres";

const controls = [
  "remote_operations",
  "remote_project_grants",
  "remote_task_contexts",
  "remote_approval_contexts",
  "remote_audit_events",
  "task_submissions",
  "codex_threads",
  "codex_turns",
  "cloud_repository_imports",
  "workspace_snapshots",
  "workspace_transfers",
];
const localCollections = new Set([
  "settings",
  "providers",
  "agentBindings",
  "permission-rules",
  "storagePolicies",
]);
const businessCollections = new Set([
  "tasks",
  "projects",
  "conversations",
  "conversationGroups",
  "approvals",
  "gitAccounts",
  "conversationContexts",
  "message_progress",
]);
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function fingerprint(rows: unknown[]) {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((row) => JSON.stringify(canonical(row))).sort()))
    .digest("hex");
}
function camel(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

/** 只允许云 Runner 业务表的完整空库导入，未知非空业务表必须先实现适配器。 */
export async function migrateRunner(source: Database.Database, db: PostgresUnitOfWork) {
  if (!source.readonly || source.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("Runner migration requires a verified read-only SQLite backup");
  source.exec("BEGIN");
  try {
    return await db.transaction(async () => {
      await db.lock("runner-migration");
      const tables = (
        await db.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'",
        )
      ).rows;
      for (const { table_name } of tables) {
        if (table_name === "business_schema_version") continue;
        if ((await db.query(`SELECT 1 FROM ${ident(table_name)} LIMIT 1`)).rowCount)
          throw new Error("Runner migration target is not empty");
      }
      const sourceTables = (
        source
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      const rows = (table: string) =>
        source.prepare(`SELECT * FROM ${ident(table)}`).all() as Record<string, unknown>[];
      const handled = new Set([
        "documents",
        "messages",
        "runs",
        "run_events",
        "event_retention",
        "artifacts",
        "traces",
        "secrets",
        "remote_schema_migrations",
        ...controls,
      ]);
      for (const table of sourceTables) {
        if (handled.has(table) || table.startsWith("memories_fts")) continue;
        if (rows(table).length)
          throw new Error(`Unsupported nonempty Runner business table: ${table}`);
      }
      const documents = rows("documents");
      for (const row of documents)
        if (
          !localCollections.has(String(row.collection)) &&
          !businessCollections.has(String(row.collection))
        )
          throw new Error(`Unsupported Runner document collection: ${String(row.collection)}`);
      const reports: { table: string; rows: number; sha256: string }[] = [];
      const copy = async (table: string, records: Record<string, unknown>[]) => {
        const columns = (
          await db.query<{ column_name: string; data_type: string }>(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
            [table],
          )
        ).rows;
        const normalize = (record: Record<string, unknown>) =>
          Object.fromEntries(
            columns
              .filter((c) => Object.hasOwn(record, c.column_name))
              .map((c) => {
                let value = record[c.column_name];
                if (c.data_type.includes("timestamp"))
                  value = (value instanceof Date ? value : new Date(String(value))).toISOString();
                if (["bigint", "integer"].includes(c.data_type)) {
                  value = Number(value);
                  if (!Number.isSafeInteger(value)) throw new Error("Unsafe migration integer");
                }
                return [c.column_name, value];
              }),
          );
        const expected = records.map(normalize);
        for (const record of expected) {
          const names = Object.keys(record);
          await db.query(
            `INSERT INTO ${ident(table)} (${names.map(ident).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
            names.map((name) => {
              const column = columns.find((c) => c.column_name === name)!;
              return column.data_type === "jsonb" ? JSON.stringify(record[name]) : record[name];
            }),
          );
        }
        const names = expected.length
          ? Object.keys(expected[0]!)
          : columns.map((c) => c.column_name);
        const actual = (
          await db.query(`SELECT ${names.map(ident).join(",")} FROM ${ident(table)}`)
        ).rows.map(normalize);
        const hash = fingerprint(expected);
        if (expected.length !== actual.length || hash !== fingerprint(actual))
          throw new Error(`Runner reconciliation failed: ${table}`);
        reports.push({ table, rows: expected.length, sha256: hash });
      };
      await copy(
        "business_documents",
        documents
          .filter(
            (row) =>
              businessCollections.has(String(row.collection)) &&
              row.collection !== "message_progress",
          )
          .map((row) => ({
            collection: row.collection,
            id: row.id,
            data: JSON.parse(String(row.data)),
            updated_at: row.updated_at,
          })),
      );
      const progress = new Map(
        documents
          .filter((row) => row.collection === "message_progress")
          .map((row) => [row.id, JSON.parse(String(row.data)).blocks]),
      );
      await copy(
        "business_messages",
        rows("messages").map((row) => {
          const data = camel(row);
          data.toolCalls = JSON.parse(String(row.tool_calls));
          if (progress.has(row.id)) data.display = progress.get(row.id);
          return {
            id: row.id,
            conversation_id: row.conversation_id,
            created_at: row.created_at,
            data,
          };
        }),
      );
      await copy(
        "business_runs",
        rows("runs").map((row) => {
          const data = camel(row);
          data.input = JSON.parse(String(row.input));
          data.toolCalls = row.tool_calls === null ? null : JSON.parse(String(row.tool_calls));
          data.cancelRequested = !!row.cancel_requested;
          return {
            id: row.id,
            task_id: row.task_id,
            idempotency_key: row.idempotency_key,
            status: row.status,
            execution_owner: row.execution_owner ?? "local",
            created_at: row.created_at,
            data,
          };
        }),
      );
      await copy(
        "business_artifacts",
        rows("artifacts").map((row) => {
          const data = camel(row);
          data.metadata = row.metadata === null ? null : JSON.parse(String(row.metadata));
          const metadata = data.metadata as Record<string, unknown> | null;
          data.artifactKey =
            typeof metadata?.artifactKey === "string"
              ? metadata.artifactKey
              : row.file_path
                ? `${row.kind}:${row.file_path}`
                : row.kind;
          return {
            id: row.id,
            task_id: row.task_id,
            run_id: row.run_id,
            artifact_key: data.artifactKey,
            version: row.version,
            created_at: row.created_at,
            data,
          };
        }),
      );
      await copy(
        "business_run_events",
        rows("run_events").map(({ id, event, ...rest }) => ({
          seq: id,
          ...rest,
          event: JSON.parse(String(event)),
        })),
      );
      await copy(
        "business_event_retention",
        sourceTables.includes("event_retention") ? rows("event_retention") : [],
      );
      await copy(
        "business_traces",
        rows("traces").map((row) => ({ ...row, event: JSON.parse(String(row.event)) })),
      );
      for (const table of controls) {
        const records = sourceTables.includes(table) ? rows(table) : [];
        if (["remote_task_contexts", "remote_approval_contexts"].includes(table)) {
          const ordered = source
            .prepare(`SELECT rowid AS created_seq,* FROM ${ident(table)} ORDER BY rowid`)
            .all() as Record<string, unknown>[];
          await copy(table, ordered);
        } else await copy(table, records);
      }
      for (const [table, column] of [
        ["business_run_events", "seq"],
        ["business_traces", "id"],
        ["remote_audit_events", "seq"],
        ["remote_task_contexts", "created_seq"],
        ["remote_approval_contexts", "created_seq"],
      ]) {
        await db.query(
          `SELECT setval(pg_get_serial_sequence($1,$2),COALESCE((SELECT max(${ident(column!)}) FROM ${ident(table!)}),1),EXISTS(SELECT 1 FROM ${ident(table!)}))`,
          [table, column],
        );
      }
      return {
        verified: true,
        tables: reports,
        localOnly: {
          secretRows: rows("secrets").length,
          documentRows: documents.filter((row) => localCollections.has(String(row.collection)))
            .length,
        },
        fts: "Cloud Runner does not expose desktop memory search; SQLite FTS indexes are not imported",
      };
    });
  } finally {
    source.exec("ROLLBACK");
  }
}

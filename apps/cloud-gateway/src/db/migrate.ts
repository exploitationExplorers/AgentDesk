import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { GatewayDatabase } from "./database";

export const GATEWAY_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "gateway_meta",
  "gateway_limits",
  "gateway_audit",
  "gateway_session_auth",
  "gateway_remote_requests",
  "device_pairings",
  "devices",
  "device_challenges",
  "device_tokens",
  "gateway_transfers",
] as const;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
interface Column {
  column_name: string;
  data_type: string;
}
function canonical(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (type.includes("timestamp")) {
    const date =
      value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid migration timestamp");
    return date.toISOString();
  }
  if (type === "boolean") return value === true || value === 1;
  if (["bigint", "integer", "smallint"].includes(type)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("Invalid migration integer");
    return number;
  }
  return value;
}
function fingerprint(rows: Record<string, unknown>[], columns: Column[]) {
  const records = rows
    .map((row) =>
      JSON.stringify(columns.map((column) => canonical(row[column.column_name], column.data_type))),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** 仅从只读 SQLite 快照导入空目标；全表对账通过后才提交，不接受覆盖或增量合并。 */
export async function migrateGateway(source: Database.Database, target: GatewayDatabase) {
  if (target.dialect !== "postgres") throw new Error("Migration target must be PostgreSQL");
  if (!source.readonly) throw new Error("Migration source must be a read-only SQLite backup");
  if (source.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("SQLite backup integrity failed");
  const tables = (
    source
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
  if (
    tables.length !== GATEWAY_TABLES.length ||
    tables.some((table) => !GATEWAY_TABLES.includes(table as (typeof GATEWAY_TABLES)[number]))
  )
    throw new Error("Unsupported SQLite Gateway schema; migration requires all expected tables");
  source.exec("BEGIN");
  try {
    return await target.transaction(async () => {
      const reports: { table: string; rows: number; sha256: string }[] = [];
      for (const table of GATEWAY_TABLES) {
        const name = identifier(table);
        const existing = (await target.prepare(`SELECT count(*) AS count FROM ${name}`).get()) as {
          count: number;
        };
        if (table === "gateway_meta") {
          const metadata = (await target.prepare(`SELECT * FROM ${name}`).all()) as {
            key: string;
            value: string;
          }[];
          if (metadata.some((row) => row.key !== "schema_version" || row.value !== "1"))
            throw new Error("Migration target is not empty");
          await target.prepare(`DELETE FROM ${name}`).run();
        } else if (existing.count !== 0) throw new Error("Migration target is not empty");
        const columns = (await target
          .prepare(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position",
          )
          .all(table)) as Column[];
        const sourceColumns = (
          source.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
        ).map((row) => row.name);
        if (
          !columns.length ||
          columns.length !== sourceColumns.length ||
          columns.some((column) => !sourceColumns.includes(column.column_name))
        )
          throw new Error(`Migration column mismatch: ${table}`);
        const rows = source.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];
        const insert = target.prepare(
          `INSERT INTO ${name} (${columns.map((c) => identifier(c.column_name)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        );
        for (const row of rows)
          await insert.run(...columns.map((c) => canonical(row[c.column_name], c.data_type)));
        const imported = (await target.prepare(`SELECT * FROM ${name}`).all()) as Record<
          string,
          unknown
        >[];
        const hash = fingerprint(rows, columns);
        if (imported.length !== rows.length || fingerprint(imported, columns) !== hash)
          throw new Error(`Migration reconciliation failed: ${table}`);
        reports.push({ table, rows: rows.length, sha256: hash });
      }
      await target.exec(
        "SELECT setval(pg_get_serial_sequence('gateway_audit','seq'), COALESCE((SELECT max(seq) FROM gateway_audit),1), EXISTS(SELECT 1 FROM gateway_audit))",
      );
      return { tables: reports, verified: true as const };
    })();
  } finally {
    source.exec("ROLLBACK");
  }
}

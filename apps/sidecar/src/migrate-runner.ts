import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { PostgresUnitOfWork } from "./db/postgres";
import { migrateRunner } from "./db/migrate-runner";
import { PostgresTaskPersistence } from "./services/storage/postgres-task-persistence";

const [sourcePath, reportPath] = process.argv.slice(2);
if (!sourcePath || !reportPath || !process.env.DATABASE_URL_FILE)
  throw new Error(
    "Usage: DATABASE_URL_FILE=... migrate-runner <readonly-backup.sqlite> <report.json>",
  );
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const db = await PostgresUnitOfWork.connect(
  readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
  process.env.DATABASE_SCHEMA ?? "runner",
);
try {
  await new PostgresTaskPersistence(db).initialize();
  const report = await migrateRunner(source, db);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ verified: report.verified, tables: report.tables.length }));
} finally {
  source.close();
  await db.close();
}

import { join, resolve } from "node:path";
import { loadDatabaseConfig } from "./config";
import { createPostgresDatabase, gatewayDatabase } from "./db/database";
import Database from "better-sqlite3";
import { recoverOwner } from "./auth/recovery";

const [action, email] = process.argv.slice(2);
if (
  !process.env.GATEWAY_DATA_DIR ||
  !["revoke-sessions", "set-owner-email"].includes(action ?? "") ||
  (action === "set-owner-email" ? !email : !!email) ||
  process.argv.length > 4
)
  throw new Error(
    "Set GATEWAY_DATA_DIR; usage: recover.mjs revoke-sessions | set-owner-email <email>. Stop gateway before recovery.",
  );
const config = loadDatabaseConfig();
const db = config.databaseUrl
  ? await createPostgresDatabase(config.databaseUrl, config.databaseSchema)
  : gatewayDatabase(
      new Database(join(resolve(process.env.GATEWAY_DATA_DIR), "gateway.db"), {
        fileMustExist: true,
      }),
    );
try {
  await recoverOwner(db, email);
  console.info(
    email
      ? "Owner updated; update OWNER_EMAIL before restarting gateway. All sessions revoked."
      : "All sessions and pending codes revoked.",
  );
} finally {
  await db.close();
}

import { join, resolve } from "node:path";
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
const db = new Database(join(resolve(process.env.GATEWAY_DATA_DIR), "gateway.db"), {
  fileMustExist: true,
});
try {
  recoverOwner(db, email);
  console.info(
    email
      ? "Owner updated; update OWNER_EMAIL before restarting gateway. All sessions revoked."
      : "All sessions and pending codes revoked.",
  );
} finally {
  db.close();
}

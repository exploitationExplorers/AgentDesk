import { OwnerEmail } from "@agentdesk/shared";
import type Database from "better-sqlite3";

/** 仅供服务器本地恢复命令使用；不注册 HTTP 入口，也不改变 owner 的不可变 ID。 */
export function recoverOwner(db: Database.Database, email?: string): string {
  const normalized = email === undefined ? undefined : OwnerEmail.parse(email);
  return db
    .transaction(() => {
      const owners = db.prepare('SELECT id,email FROM "user"').all() as Array<{
        id: string;
        email: string;
      }>;
      const owner = owners[0];
      if (owners.length !== 1 || !owner) throw new Error("Expected exactly one initialized owner");
      db.prepare('DELETE FROM "session"').run();
      db.prepare("DELETE FROM gateway_session_auth").run();
      db.prepare("DELETE FROM verification").run();
      if (normalized)
        db.prepare('UPDATE "user" SET email=?,"emailVerified"=1,"updatedAt"=? WHERE id=?').run(
          normalized,
          new Date().toISOString(),
          owner.id,
        );
      db.prepare(
        "INSERT INTO gateway_audit(user_id,action,outcome,created_at) VALUES (?,?,?,?)",
      ).run(
        owner.id,
        normalized ? "recovery.owner-change" : "recovery.revoke-all",
        "revoked",
        Date.now(),
      );
      return owner.id;
    })
    .immediate();
}

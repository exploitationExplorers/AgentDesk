import { OwnerEmail, RemoteId } from "@agentdesk/shared";
import type Database from "better-sqlite3";
import { gatewayDatabase, type GatewayDatabase } from "../db/database";

/** 仅供服务器本地恢复命令使用；不注册 HTTP 入口，也不改变 owner 的不可变 ID。 */
export async function recoverOwner(
  database: Database.Database | GatewayDatabase,
  email?: string,
  ownerUserId = process.env.CLOUD_OWNER_USER_ID,
): Promise<string> {
  const db = gatewayDatabase(database);
  const normalized = email === undefined ? undefined : OwnerEmail.parse(email);
  const configuredOwnerId = ownerUserId?.trim() ? RemoteId.parse(ownerUserId.trim()) : undefined;
  return db
    .transaction(async () => {
      const owners = (await db.prepare('SELECT id,email FROM "user"').all()) as Array<{
        id: string;
        email: string;
      }>;
      const owner =
        (configuredOwnerId ? owners.find((user) => user.id === configuredOwnerId) : undefined) ??
        (owners.length === 1 ? owners[0] : undefined);
      if (!owner) {
        if (configuredOwnerId)
          throw new Error("Configured CLOUD_OWNER_USER_ID was not found in the user table");
        throw new Error(
          "Expected exactly one initialized owner, or set CLOUD_OWNER_USER_ID for multi-user recovery",
        );
      }
      await db.prepare('DELETE FROM "session"').run();
      await db.prepare("DELETE FROM gateway_session_auth").run();
      await db.prepare("DELETE FROM verification").run();
      if (normalized)
        await db
          .prepare('UPDATE "user" SET email=?,"emailVerified"=?,"updatedAt"=? WHERE id=?')
          .run(
            normalized,
            db.dialect === "postgres" ? true : 1,
            new Date().toISOString(),
            owner.id,
          );
      await db
        .prepare("INSERT INTO gateway_audit(user_id,action,outcome,created_at) VALUES (?,?,?,?)")
        .run(
          owner.id,
          normalized ? "recovery.owner-change" : "recovery.revoke-all",
          "revoked",
          Date.now(),
        );
      return owner.id;
    })
    .immediate();
}

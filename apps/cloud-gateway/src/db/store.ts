import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError, ErrorCode } from "@agentdesk/shared";

export class GatewayStore {
  constructor(
    readonly db: Database.Database,
    private readonly pepper: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_session_auth (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, authenticated_at TEXT NOT NULL);
    `);
    const version = db
      .prepare("SELECT value FROM gateway_meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    if (version && version.value !== "1") throw new Error("Unsupported gateway schema version");
    db.prepare("INSERT OR IGNORE INTO gateway_meta VALUES ('schema_version','1')").run();
  }

  audit(action: string, outcome: string, userId: string | null = null): void {
    this.db
      .prepare("INSERT INTO gateway_audit(user_id,action,outcome,created_at) VALUES (?,?,?,?)")
      .run(userId, action, outcome, Date.now());
  }

  /** 同一事务检查全部桶再增加计数；只保留 HMAC，不把邮箱／IP 直接写进限流键。 */
  limit(buckets: Array<{ key: string; max: number; windowMs: number }>, now = Date.now()): void {
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM gateway_limits WHERE resets_at<=?").run(now);
        const values = buckets.map((bucket) => ({
          ...bucket,
          key: createHmac("sha256", this.pepper).update(bucket.key).digest("hex"),
        }));
        for (const bucket of values) {
          const row = this.db
            .prepare("SELECT count FROM gateway_limits WHERE key=?")
            .get(bucket.key) as { count: number } | undefined;
          if (row && row.count >= bucket.max)
            throw new AppError(ErrorCode.RateLimited, "请求过于频繁，请稍后再试");
        }
        for (const bucket of values)
          this.db
            .prepare(
              `INSERT INTO gateway_limits VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET count=count+1`,
            )
            .run(bucket.key, now + bucket.windowMs);
      })
      .immediate();
  }

  revokeAll(userId: string): void {
    this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM "session" WHERE "userId"=?').run(userId);
        this.db.prepare("DELETE FROM gateway_session_auth WHERE user_id=?").run(userId);
        this.audit("sessions.revoke-all", "revoked", userId);
      })
      .immediate();
  }

  markSessionAuthenticated(userId: string, sessionId: string, at = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO gateway_session_auth(session_id,user_id,authenticated_at) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id,authenticated_at=excluded.authenticated_at`,
      )
      .run(sessionId, userId, at.toISOString());
  }

  sessionAuthenticatedAt(userId: string, sessionId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT authenticated_at AS at FROM gateway_session_auth WHERE session_id=? AND user_id=?",
        )
        .get(sessionId, userId) as { at: string } | undefined
    )?.at;
  }

  removeSession(sessionId: string): void {
    this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM "session" WHERE id=?').run(sessionId);
        this.db.prepare("DELETE FROM gateway_session_auth WHERE session_id=?").run(sessionId);
      })
      .immediate();
  }
}

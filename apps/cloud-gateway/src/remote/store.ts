import type Database from "better-sqlite3";
import { AppError, ErrorCode, type RemoteActor, type RemoteScope } from "@agentdesk/shared";

export interface RemoteSubmission {
  scope: RemoteScope;
  actor: RemoteActor;
  requestId: string;
  payloadHash: string;
  taskId: string | null;
  active: boolean;
  action?: "task.create" | "task.followup";
  accepted?: boolean;
  createdAt?: number;
}

/** 这里只保留路由和授权元数据；任务和事件的权威内容始终在执行宿主。 */
export class RemoteRoutingStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_remote_requests (
        user_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL,
        request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, scope_json TEXT NOT NULL,
        actor_json TEXT NOT NULL, task_id TEXT, active INTEGER NOT NULL DEFAULT 1,
        action TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id,host_id,project_id,action,request_id)
      );
      CREATE INDEX IF NOT EXISTS gateway_remote_request_tasks ON gateway_remote_requests(user_id,host_id,task_id);
    `);
    // 旧开发版本的记录只用于查原操作；不依赖旧记录里的 actor 自动重放请求。
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_remote_submissions'",
        )
        .get()
    ) {
      db.transaction(() => {
        db.exec(`INSERT OR IGNORE INTO gateway_remote_requests
          SELECT user_id,host_id,project_id,request_id,payload_hash,scope_json,actor_json,task_id,active,
          'task.create',CASE WHEN task_id IS NULL THEN 0 ELSE 1 END,0 FROM gateway_remote_submissions;
          DROP TABLE gateway_remote_submissions;`);
      }).immediate();
    }
  }

  claim(input: RemoteSubmission): RemoteSubmission {
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            `SELECT * FROM gateway_remote_requests
        WHERE user_id=? AND host_id=? AND project_id=? AND action=? AND request_id=?`,
          )
          .get(
            input.scope.userId,
            input.scope.hostId,
            input.scope.projectId,
            input.action ?? "task.create",
            input.requestId,
          );
        if (existing) {
          const previous = this.decode(existing);
          if (
            previous.payloadHash !== input.payloadHash ||
            previous.scope.workspaceId !== input.scope.workspaceId
          )
            throw new AppError(ErrorCode.IdempotencyConflict, "该请求已用于其他任务内容");
          if (previous.actor.sessionId !== input.actor.sessionId)
            throw new AppError(ErrorCode.Conflict, "原请求属于另一次登录，请查看原任务状态");
          return previous;
        }
        this.db
          .prepare(
            `INSERT INTO gateway_remote_requests
        (user_id,host_id,project_id,request_id,payload_hash,scope_json,actor_json,task_id,active,action,accepted,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.scope.userId,
            input.scope.hostId,
            input.scope.projectId,
            input.requestId,
            input.payloadHash,
            JSON.stringify(input.scope),
            JSON.stringify(input.actor),
            input.taskId,
            Number(input.active),
            input.action ?? "task.create",
            Number(input.accepted ?? false),
            input.createdAt ?? Date.now(),
          );
        return {
          ...input,
          action: input.action ?? "task.create",
          accepted: input.accepted ?? false,
          createdAt: input.createdAt ?? Date.now(),
        };
      })
      .immediate();
  }

  private decode(value: unknown): RemoteSubmission {
    const row = value as {
      scope_json: string;
      actor_json: string;
      request_id: string;
      payload_hash: string;
      task_id: string | null;
      active: number;
      action: "task.create" | "task.followup";
      accepted: number;
      created_at: number;
    };
    return {
      scope: JSON.parse(row.scope_json),
      actor: JSON.parse(row.actor_json),
      requestId: row.request_id,
      payloadHash: row.payload_hash,
      taskId: row.task_id,
      active: Boolean(row.active),
      action: row.action,
      accepted: Boolean(row.accepted),
      createdAt: row.created_at,
    };
  }

  active(): RemoteSubmission[] {
    return this.db
      .prepare("SELECT * FROM gateway_remote_requests WHERE active=1")
      .all()
      .map((row) => this.decode(row));
  }

  save(input: RemoteSubmission): void {
    this.db
      .prepare(
        `UPDATE gateway_remote_requests SET task_id=?,active=?,accepted=?
      WHERE user_id=? AND host_id=? AND project_id=? AND action=? AND request_id=?`,
      )
      .run(
        input.taskId,
        Number(input.active),
        Number(input.accepted ?? false),
        input.scope.userId,
        input.scope.hostId,
        input.scope.projectId,
        input.action ?? "task.create",
        input.requestId,
      );
  }

  accept(input: RemoteSubmission, taskId: string): void {
    if (input.accepted || !input.active) {
      input.taskId = taskId;
      this.save(input);
      return;
    }
    this.db
      .transaction(() => {
        // 只让最后获宿主接受的请求续租；原请求主体保持不变，不能因续跑篡改其身份。
        this.db
          .prepare(
            `UPDATE gateway_remote_requests SET active=0 WHERE task_id=? AND user_id=? AND host_id=?
        AND NOT (project_id=? AND action=? AND request_id=?)`,
          )
          .run(
            taskId,
            input.scope.userId,
            input.scope.hostId,
            input.scope.projectId,
            input.action ?? "task.create",
            input.requestId,
          );
        input.taskId = taskId;
        input.accepted = true;
        this.save(input);
      })
      .immediate();
  }

  /** 后台续租不可刷新 last activity，否则手机退出后会话永远不会空闲过期。 */
  sessionAlive(actor: RemoteActor, now = Date.now()): boolean {
    const row = this.db
      .prepare('SELECT "userId","createdAt","updatedAt","expiresAt" FROM "session" WHERE id=?')
      .get(actor.sessionId) as
      { userId: string; createdAt: string; updatedAt: string; expiresAt: string } | undefined;
    if (!row || row.userId !== actor.userId) return false;
    const created = Date.parse(row.createdAt);
    const updated = Date.parse(row.updatedAt);
    const expires = Date.parse(row.expiresAt);
    return (
      Number.isFinite(created) &&
      Number.isFinite(updated) &&
      Number.isFinite(expires) &&
      now < expires &&
      now - created < 7 * 24 * 60 * 60_000 &&
      now - updated < 12 * 60 * 60_000
    );
  }
}

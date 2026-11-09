import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteCapability,
  RemoteId,
  RemoteOperation,
  RemoteScope,
  type RemoteOperationStatus,
} from "@agentdesk/shared";
import { payloadDigest } from "./digest";

const columns = `operation_id AS operationId,user_id AS userId,host_id AS hostId,project_id AS projectId,workspace_id AS workspaceId,
  action,request_id AS requestId,payload_hash AS payloadHash,status,result_json AS result,created_at AS createdAt,updated_at AS updatedAt`;
type Row = Omit<RemoteOperation, "result"> & { result: string | null };
const parseRow = (row: Row): RemoteOperation =>
  RemoteOperation.parse({ ...row, result: row.result === null ? null : JSON.parse(row.result) });
const transitions: Record<RemoteOperationStatus, readonly RemoteOperationStatus[]> = {
  accepted: ["running", "succeeded", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancel_requested", "needs_reconciliation"],
  cancel_requested: ["cancelled", "succeeded", "failed", "needs_reconciliation"],
  needs_reconciliation: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class RemoteOperationStore {
  constructor(private readonly raw: Database.Database) {}

  get(scope: RemoteScope, operationId: string): RemoteOperation | undefined {
    const row = this.raw
      .prepare(
        `SELECT ${columns} FROM remote_operations WHERE operation_id=@operationId
      AND user_id=@userId AND host_id=@hostId AND project_id=@projectId AND workspace_id=@workspaceId`,
      )
      .get({ ...RemoteScope.parse(scope), operationId: RemoteId.parse(operationId) }) as
      Row | undefined;
    return row ? parseRow(row) : undefined;
  }

  getByRequest(
    scopeInput: RemoteScope,
    actionInput: RemoteCapability,
    requestInput: string,
  ): RemoteOperation | undefined {
    const scope = RemoteScope.parse(scopeInput);
    const action = RemoteCapability.parse(actionInput);
    const requestId = RemoteId.parse(requestInput);
    const row = this.raw
      .prepare(
        `SELECT ${columns} FROM remote_operations WHERE user_id=@userId AND host_id=@hostId
      AND project_id=@projectId AND workspace_id=@workspaceId AND action=@action AND request_id=@requestId`,
      )
      .get({ ...scope, action, requestId }) as Row | undefined;
    return row ? parseRow(row) : undefined;
  }

  /** 回调只能做同一连接内的同步数据库写入；网络、调度和 Git 在提交事务后执行。 */
  accept(
    scopeInput: RemoteScope,
    actionInput: RemoteCapability,
    requestInput: string,
    payload: unknown,
    initialize?: (operationId: string) => z.infer<ReturnType<typeof z.json>>,
  ): { operation: RemoteOperation; replayed: boolean } {
    const scope = RemoteScope.parse(scopeInput);
    const action = RemoteCapability.parse(actionInput);
    const requestId = RemoteId.parse(requestInput);
    const hash = payloadDigest(payload);
    return this.raw
      .transaction(() => {
        const existing = this.raw
          .prepare(
            `SELECT ${columns} FROM remote_operations
        WHERE user_id=@userId AND host_id=@hostId AND project_id=@projectId AND action=@action AND request_id=@requestId`,
          )
          .get({ ...scope, action, requestId }) as Row | undefined;
        if (existing) {
          if (existing.payloadHash !== hash || existing.workspaceId !== scope.workspaceId)
            throw new AppError(ErrorCode.IdempotencyConflict, "该请求 ID 已用于不同内容或工作区");
          return { operation: parseRow(existing), replayed: true };
        }
        const now = new Date().toISOString();
        const operation: RemoteOperation = {
          operationId: randomUUID(),
          ...scope,
          action,
          requestId,
          payloadHash: hash,
          status: "accepted",
          result: null,
          createdAt: now,
          updatedAt: now,
        };
        this.raw
          .prepare(
            `INSERT INTO remote_operations VALUES
        (@operationId,@userId,@hostId,@projectId,@workspaceId,@action,@requestId,@payloadHash,@status,NULL,@createdAt,@updatedAt)`,
          )
          .run(operation);
        if (initialize) {
          operation.result = z.json().parse(initialize(operation.operationId));
          this.raw
            .prepare("UPDATE remote_operations SET result_json=? WHERE operation_id=?")
            .run(JSON.stringify(operation.result), operation.operationId);
        }
        this.audit(operation);
        return { operation, replayed: false };
      })
      .immediate();
  }

  transition(
    scope: RemoteScope,
    operationId: string,
    status: RemoteOperationStatus,
    result: RemoteOperation["result"],
  ): RemoteOperation {
    return this.raw
      .transaction(() => {
        const operation = this.get(scope, operationId);
        if (!operation) throw new AppError(ErrorCode.NotFound, "操作不存在");
        if (
          operation.status === status &&
          payloadDigest(operation.result) === payloadDigest(result)
        )
          return operation;
        if (!transitions[operation.status].includes(status))
          throw new AppError(ErrorCode.Conflict, "操作状态不可迁移");
        const next = RemoteOperation.parse({
          ...operation,
          status,
          result,
          updatedAt: new Date().toISOString(),
        });
        this.raw
          .prepare(
            "UPDATE remote_operations SET status=?,result_json=?,updated_at=? WHERE operation_id=?",
          )
          .run(status, JSON.stringify(next.result), next.updatedAt, operationId);
        this.audit(next);
        return next;
      })
      .immediate();
  }

  /** 启动时只标记不确定的外部副作用，不能把领取过的 commit 重新执行。 */
  reconcileInterrupted(hostId: string): number {
    return this.raw
      .transaction(() => {
        const rows = this.raw
          .prepare(
            `SELECT ${columns} FROM remote_operations
        WHERE host_id=? AND status IN ('running','cancel_requested')`,
          )
          .all(RemoteId.parse(hostId)) as Row[];
        for (const row of rows) {
          const { userId, hostId: host, projectId, workspaceId } = row;
          this.transition(
            { userId, hostId: host, projectId, workspaceId },
            row.operationId,
            "needs_reconciliation",
            parseRow(row).result,
          );
        }
        return rows.length;
      })
      .immediate();
  }

  private audit(operation: RemoteOperation): void {
    this.raw
      .prepare(
        `INSERT INTO remote_audit_events
      (user_id,host_id,project_id,workspace_id,action,request_id,operation_id,outcome,created_at)
      VALUES (@userId,@hostId,@projectId,@workspaceId,@action,@requestId,@operationId,@status,@updatedAt)`,
      )
      .run(operation);
  }
}

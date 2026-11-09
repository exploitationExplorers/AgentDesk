import type Database from "better-sqlite3";
import {
  AppError,
  ErrorCode,
  RemoteApprovalContext,
  RemoteApprovalDecision,
  RemoteScope,
} from "@agentdesk/shared";
import type { ApprovalService } from "../approvals";
import { RemoteOperationStore } from "./operations";

const columns = `approval_id AS approvalId,operation_id AS operationId,task_id AS taskId,user_id AS userId,host_id AS hostId,
  project_id AS projectId,workspace_id AS workspaceId,action,action_digest AS actionDigest,version,expires_at AS expiresAt,
  resolved_by AS resolvedBy,decision`;

/** 保留本地审批语义，远程入口额外强制范围、指纹、版本、有效期和相反决定冲突。 */
export class RemoteApprovalService {
  constructor(
    private readonly raw: Database.Database,
    private readonly approvals: ApprovalService,
  ) {}

  attach(input: RemoteApprovalContext): void {
    const context = RemoteApprovalContext.parse(input);
    const { userId, hostId, projectId, workspaceId } = context;
    const operation = new RemoteOperationStore(this.raw).get(
      { userId, hostId, projectId, workspaceId },
      context.operationId,
    );
    const approval = this.approvals.get(context.approvalId);
    if (
      !operation ||
      !approval ||
      approval.status !== "pending" ||
      context.resolvedBy ||
      context.decision !== null
    )
      throw new AppError(ErrorCode.Conflict, "审批关联的操作或状态无效");
    if (context.taskId) {
      const task = this.raw
        .prepare(
          `SELECT 1 FROM remote_task_contexts WHERE task_id=@taskId AND operation_id=@operationId
        AND user_id=@userId AND host_id=@hostId AND project_id=@projectId AND workspace_id=@workspaceId`,
        )
        .get(context);
      if (!task) throw new AppError(ErrorCode.Forbidden, "审批任务归属不匹配");
    }
    this.raw
      .prepare(
        `INSERT INTO remote_approval_contexts
      (approval_id,operation_id,task_id,user_id,host_id,project_id,workspace_id,action,action_digest,version,expires_at,resolved_by,decision)
      VALUES (@approvalId,@operationId,@taskId,@userId,@hostId,@projectId,@workspaceId,@action,@actionDigest,@version,@expiresAt,NULL,NULL)`,
      )
      .run(context);
  }

  get(input: RemoteScope, approvalId: string): RemoteApprovalContext | undefined {
    const scope = RemoteScope.parse(input);
    const row = this.raw
      .prepare(
        `SELECT ${columns} FROM remote_approval_contexts WHERE approval_id=@approvalId
      AND user_id=@userId AND host_id=@hostId AND project_id=@projectId AND workspace_id=@workspaceId`,
      )
      .get({ ...scope, approvalId }) as
      (Omit<RemoteApprovalContext, "decision"> & { decision: number | null }) | undefined;
    return row
      ? RemoteApprovalContext.parse({
          ...row,
          decision: row.decision === null ? null : row.decision === 1,
        })
      : undefined;
  }

  /** 调用前入口仍须验证当前会话／lease；clientRequestId 用于审计，审批自身以版本和决定去重。 */
  resolve(
    input: RemoteScope,
    approvalId: string,
    decisionInput: RemoteApprovalDecision,
    now = Date.now(),
  ) {
    const scope = RemoteScope.parse(input);
    const decision = RemoteApprovalDecision.parse(decisionInput);
    const context = this.raw
      .transaction(() => {
        const current = this.get(scope, approvalId);
        if (!current) throw new AppError(ErrorCode.NotFound, "审批不存在");
        if (current.version !== decision.version || current.actionDigest !== decision.actionDigest)
          throw new AppError(ErrorCode.Conflict, "审批版本或动作摘要已改变");
        if (current.decision !== null) {
          if (current.decision !== decision.approved)
            throw new AppError(ErrorCode.Conflict, "审批已有相反决定");
          return current;
        }
        const approval = this.approvals.get(approvalId);
        if (!approval || approval.status !== "pending" || Date.parse(current.expiresAt) <= now)
          throw new AppError(ErrorCode.ApprovalExpired, "审批已过期或由其他入口处理");
        this.raw
          .prepare(
            "UPDATE remote_approval_contexts SET decision=?,resolved_by=? WHERE approval_id=?",
          )
          .run(decision.approved ? 1 : 0, scope.userId, approvalId);
        this.raw
          .prepare(
            `INSERT INTO remote_audit_events
        (user_id,host_id,project_id,workspace_id,action,request_id,operation_id,outcome,created_at)
        VALUES (@userId,@hostId,@projectId,@workspaceId,'approval.resolve',@requestId,@operationId,@outcome,@createdAt)`,
          )
          .run({
            ...scope,
            requestId: decision.clientRequestId,
            operationId: current.operationId,
            outcome: decision.approved ? "approved" : "rejected",
            createdAt: new Date(now).toISOString(),
          });
        return { ...current, decision: decision.approved, resolvedBy: scope.userId };
      })
      .immediate();
    // 决定持久化后才唤醒工具；进程若在此处崩溃，重启会使原 Approval 过期，不重放外部操作。
    const approval = this.approvals.resolve(approvalId, decision.approved);
    if (approval.status !== (decision.approved ? "approved" : "rejected"))
      throw new AppError(ErrorCode.ApprovalExpired, "执行等待方已失效，不能继续原审批");
    return { approval, context };
  }
}

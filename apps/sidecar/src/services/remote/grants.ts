import { businessDatabase, type BusinessDatabase } from "../../db/business-database";
import type Database from "better-sqlite3";
import {
  AppError,
  ErrorCode,
  ProjectGrant,
  RemoteCommand,
  RemoteScope,
  type RemoteCapability,
} from "@agentdesk/shared";
import { payloadDigest } from "./digest";
const RECENT_AUTH_MS = 15 * 60000;
const SENSITIVE = new Set<RemoteCapability>(["git.push", "provider.write", "credentials.write"]);
export class RemoteGrantStore {
  private readonly raw: BusinessDatabase;
  constructor(
    raw: Database.Database | BusinessDatabase,
    private readonly hostId: string,
  ) {
    this.raw = businessDatabase(raw);
  }
  /** 仅供已验证身份的配对／lease 维护方调用，不接受模型或普通任务正文。 */
  async put(input: ProjectGrant): Promise<void> {
    const grant = ProjectGrant.parse(input);
    if (grant.hostId !== this.hostId) throw new AppError(ErrorCode.Forbidden, "宿主不匹配");
    await this.raw
      .transaction(async () => {
        const { userId, hostId, projectId, workspaceId } = grant;
        const existing = await this.get({ userId, hostId, projectId, workspaceId });
        if (
          existing &&
          (grant.connectionEpoch < existing.connectionEpoch ||
            (existing.revokedAt && grant.connectionEpoch <= existing.connectionEpoch))
        )
          throw new AppError(ErrorCode.Conflict, "连接 epoch 已失效");
        await this.raw
          .prepare(
            `INSERT INTO remote_project_grants VALUES (@userId,@hostId,@projectId,@workspaceId,@capabilities,@connectionEpoch,@expiresAt,@revokedAt)
        ON CONFLICT(user_id,host_id,project_id,workspace_id) DO UPDATE SET
        capabilities_json=excluded.capabilities_json, connection_epoch=excluded.connection_epoch,
        expires_at=excluded.expires_at, revoked_at=excluded.revoked_at`,
          )
          .run({ ...grant, capabilities: JSON.stringify(grant.capabilities) });
      })
      .immediate();
  }
  async get(input: RemoteScope): Promise<ProjectGrant | undefined> {
    // 内部调用也会传入任务上下文；只用授权维度查询，入口仍严格校验完整协议。
    const { userId, hostId, projectId, workspaceId } = input;
    const scope = RemoteScope.parse({ userId, hostId, projectId, workspaceId });
    const row = (await this.raw
      .prepare(
        `SELECT user_id AS userId,host_id AS hostId,project_id AS projectId,workspace_id AS workspaceId,
      capabilities_json AS capabilities,connection_epoch AS connectionEpoch,expires_at AS expiresAt,revoked_at AS revokedAt
      FROM remote_project_grants WHERE user_id=@userId AND host_id=@hostId AND project_id=@projectId AND workspace_id=@workspaceId`,
      )
      .get(scope)) as
      | (Omit<ProjectGrant, "capabilities"> & {
          capabilities: string;
        })
      | undefined;
    return row
      ? ProjectGrant.parse({ ...row, capabilities: JSON.parse(row.capabilities) })
      : undefined;
  }
  async revoke(input: RemoteScope, now = Date.now()): Promise<void> {
    await this.raw
      .prepare(
        `UPDATE remote_project_grants SET revoked_at=@now
      WHERE user_id=@userId AND host_id=@hostId AND project_id=@projectId AND workspace_id=@workspaceId`,
      )
      .run({ ...RemoteScope.parse(input), now: new Date(now).toISOString() });
  }
  async authorize(
    input: RemoteCommand,
    payload: unknown,
    now = Date.now(),
  ): Promise<RemoteCommand> {
    const command = RemoteCommand.parse(input);
    const { userId, hostId, projectId, workspaceId } = command;
    const grant = await this.get({ userId, hostId, projectId, workspaceId });
    if (
      hostId !== this.hostId ||
      !grant ||
      grant.revokedAt ||
      grant.connectionEpoch !== command.connectionEpoch ||
      !grant.capabilities.includes(command.action)
    )
      throw new AppError(ErrorCode.Forbidden, "没有该宿主／项目／工作区的操作权限");
    const issuedAt = Date.parse(command.issuedAt);
    const expiresAt = Date.parse(command.expiresAt);
    if (
      issuedAt > now + 5000 ||
      now - issuedAt > 60000 ||
      expiresAt <= now ||
      expiresAt - issuedAt > 60000 ||
      Date.parse(grant.expiresAt) < expiresAt
    )
      throw new AppError(ErrorCode.Forbidden, "命令或设备授权已过期");
    if (command.payloadHash !== payloadDigest(payload))
      throw new AppError(ErrorCode.BadRequest, "命令内容摘要不匹配");
    const authAge = now - Date.parse(command.actor.recentAuthAt);
    if (authAge < -5000 || (SENSITIVE.has(command.action) && authAge > RECENT_AUTH_MS))
      throw new AppError(ErrorCode.Unauthorized, "此操作需要近期身份验证");
    return command;
  }
}

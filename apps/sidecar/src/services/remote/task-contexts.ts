import type Database from "better-sqlite3";
import { RemoteTaskContext } from "@agentdesk/shared";

export function attachRemoteTask(raw: Database.Database, input: RemoteTaskContext): void {
  const context = RemoteTaskContext.parse(input);
  raw
    .prepare(
      `INSERT INTO remote_task_contexts
    (task_id,operation_id,user_id,host_id,project_id,workspace_id,session_id,recent_auth_at,executor,connection_epoch,lease_expires_at)
    VALUES (@taskId,@operationId,@userId,@hostId,@projectId,@workspaceId,@sessionId,@recentAuthAt,@executor,@connectionEpoch,@leaseExpiresAt)`,
    )
    .run({ ...context, ...context.actor });
}

export function readRemoteTask(
  raw: Database.Database,
  taskId: string,
): RemoteTaskContext | undefined {
  const row = raw
    .prepare(
      `SELECT task_id AS taskId,operation_id AS operationId,user_id AS userId,host_id AS hostId,
    project_id AS projectId,workspace_id AS workspaceId,session_id AS sessionId,recent_auth_at AS recentAuthAt,
    executor,connection_epoch AS connectionEpoch,lease_expires_at AS leaseExpiresAt FROM remote_task_contexts WHERE task_id=?`,
    )
    .get(taskId) as
    (Omit<RemoteTaskContext, "actor"> & { sessionId: string; recentAuthAt: string }) | undefined;
  if (!row) return undefined;
  const { sessionId, recentAuthAt, ...context } = row;
  return RemoteTaskContext.parse({
    ...context,
    actor: { userId: row.userId, sessionId, recentAuthAt },
  });
}

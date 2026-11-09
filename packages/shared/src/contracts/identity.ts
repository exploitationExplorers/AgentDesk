import { z } from "zod";

export const RemoteId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const Sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RemoteActor = z.strictObject({
  userId: RemoteId,
  sessionId: RemoteId,
  recentAuthAt: z.iso.datetime(),
});
export type RemoteActor = z.infer<typeof RemoteActor>;

export const RemoteScope = z.strictObject({
  userId: RemoteId,
  hostId: RemoteId,
  projectId: RemoteId,
  workspaceId: RemoteId,
});
export type RemoteScope = z.infer<typeof RemoteScope>;

export const HostKind = z.enum(["cloud", "office"]);
export const ExecutorKind = z.enum(["native-bot", "codex"]);
export type ExecutorKind = z.infer<typeof ExecutorKind>;

/** 邮箱只用于登录标识；资源授权始终使用不可变 userId。 */
export const OwnerEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const RemoteCapability = z.enum([
  "project.read",
  "task.read",
  "task.create",
  "task.followup",
  "task.cancel",
  "approval.resolve",
  "git.preview",
  "git.commit",
  "git.push",
  "snapshot.create",
  "snapshot.read",
  "transfer.import",
  "provider.read",
  "provider.write",
  "provider.test",
  "credentials.write",
]);
export type RemoteCapability = z.infer<typeof RemoteCapability>;

export const ProjectGrant = z.strictObject({
  ...RemoteScope.shape,
  capabilities: z.array(RemoteCapability).min(1).max(32),
  connectionEpoch: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ProjectGrant = z.infer<typeof ProjectGrant>;

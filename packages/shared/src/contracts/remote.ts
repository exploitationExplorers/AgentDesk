import { z } from "zod";
import {
  ExecutorKind,
  RemoteActor,
  RemoteCapability,
  RemoteId,
  RemoteScope,
  Sha256Digest,
} from "./identity";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_HEARTBEAT_MS = 15_000;
export const REMOTE_LEASE_MS = 45_000;
export const REMOTE_MAX_MESSAGE_BYTES = 256 * 1024;

export const RemoteCommand = z
  .strictObject({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    messageId: RemoteId,
    requestId: RemoteId,
    ...RemoteScope.shape,
    actor: RemoteActor,
    connectionEpoch: z.number().int().positive(),
    action: RemoteCapability,
    payloadHash: Sha256Digest,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(
    (command) => command.actor.userId === command.userId,
    "Actor does not match resource owner",
  )
  .refine(
    (command) => Date.parse(command.expiresAt) > Date.parse(command.issuedAt),
    "Invalid command lifetime",
  );
export type RemoteCommand = z.infer<typeof RemoteCommand>;

export const RemoteTaskInput = z.strictObject({
  clientRequestId: RemoteId,
  goal: z.string().trim().min(1).max(32_000),
  title: z.string().trim().min(1).max(200).optional(),
  executor: ExecutorKind,
  workspaceMode: z.enum(["existing", "isolated"]),
  workspaceId: RemoteId,
  requiresPlanApproval: z.boolean().default(true),
});
export type RemoteTaskInput = z.infer<typeof RemoteTaskInput>;

export const RemoteOperationStatus = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "needs_reconciliation",
]);
export type RemoteOperationStatus = z.infer<typeof RemoteOperationStatus>;
export const RemoteOperation = z.strictObject({
  operationId: RemoteId,
  ...RemoteScope.shape,
  action: RemoteCapability,
  requestId: RemoteId,
  payloadHash: Sha256Digest,
  status: RemoteOperationStatus,
  result: z.json().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RemoteOperation = z.infer<typeof RemoteOperation>;

export const RemoteTaskContext = z.strictObject({
  taskId: RemoteId,
  operationId: RemoteId,
  ...RemoteScope.shape,
  actor: RemoteActor,
  executor: ExecutorKind,
  connectionEpoch: z.number().int().positive(),
  leaseExpiresAt: z.iso.datetime(),
});
export type RemoteTaskContext = z.infer<typeof RemoteTaskContext>;

export const RemoteApprovalContext = z.strictObject({
  approvalId: RemoteId,
  ...RemoteScope.shape,
  operationId: RemoteId,
  taskId: RemoteId.nullable(),
  action: RemoteCapability,
  actionDigest: Sha256Digest,
  version: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  resolvedBy: RemoteId.nullable(),
  decision: z.boolean().nullable(),
});
export type RemoteApprovalContext = z.infer<typeof RemoteApprovalContext>;

export const RemoteApprovalDecision = z.strictObject({
  clientRequestId: RemoteId,
  version: z.number().int().positive(),
  actionDigest: Sha256Digest,
  approved: z.boolean(),
});
export type RemoteApprovalDecision = z.infer<typeof RemoteApprovalDecision>;

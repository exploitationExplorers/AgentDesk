import { z } from "zod";

const Id = z.string().min(1).max(128);
const Text = z.string().trim().min(1);
export const TeamRevision = z.string().regex(/^[a-f0-9]{40}$/);
export const TeamRepository = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "使用不含凭据的 HTTPS 仓库地址");
export const TeamRoomInput = z.strictObject({
  name: Text.max(100),
  ownerName: Text.max(80),
  goal: Text.max(12000),
  repository: TeamRepository,
  baseRevision: TeamRevision,
});
export type TeamRoomInput = z.infer<typeof TeamRoomInput>;
export const TeamRoom = TeamRoomInput.omit({ ownerName: true }).extend({
  id: Id,
  ownerId: Id,
  createdAt: z.string(),
});
export type TeamRoom = z.infer<typeof TeamRoom>;
export const TeamMember = z.object({
  id: Id,
  roomId: Id,
  name: z.string(),
  role: z.enum(["owner", "member"]),
  revoked: z.boolean(),
  connectedAt: z.string().optional(),
  executor: z.string().optional(),
});
export type TeamMember = z.infer<typeof TeamMember>;
export const TeamSession = z.object({ token: z.string(), member: TeamMember, room: TeamRoom });
export type TeamSession = z.infer<typeof TeamSession>;
export const TeamMessageInput = z.strictObject({
  requestId: Id,
  content: Text.max(12000),
  replyToId: Id.optional(),
  mentionIds: z.array(Id).max(30).default([]),
});
export const TeamMessage = TeamMessageInput.omit({ requestId: true }).extend({
  id: Id,
  roomId: Id,
  seq: z.number().int().positive(),
  authorId: Id,
  authorKind: z.enum(["human", "agent", "system"]),
  createdAt: z.string(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;
export const TeamTaskInput = z.strictObject({
  title: Text.max(200),
  instructions: Text.max(16000),
  assigneeId: Id,
  kind: z.enum(["develop", "integrate"]).default("develop"),
  dependsOn: z.array(Id).max(30).default([]),
  acceptance: z.array(Text.max(1000)).min(1).max(20),
});
export type TeamTaskInput = z.infer<typeof TeamTaskInput>;
export const TeamCheck = z.strictObject({
  name: Text.max(160),
  exitCode: z.number().int().min(0).max(255),
});
export const TeamDelivery = z.strictObject({
  revision: TeamRevision,
  summary: Text.max(12000),
  checks: z.array(TeamCheck).min(1).max(20),
});
export type TeamDelivery = z.infer<typeof TeamDelivery>;
export const TeamTask = TeamTaskInput.extend({
  id: z.string().uuid(),
  roomId: Id,
  branch: z.string().regex(/^agentdesk\/[a-f0-9-]{36}-[1-9][0-9]*$/),
  baseRevision: TeamRevision,
  status: z.enum(["queued", "running", "blocked", "submitted", "approved", "cancelled"]),
  attempt: z.number().int(),
  progress: z.string(),
  leaseExpiresAt: z.string().optional(),
  delivery: TeamDelivery.optional(),
  review: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeamTask = z.infer<typeof TeamTask>;
export const TeamDetail = z.object({
  room: TeamRoom,
  me: TeamMember,
  members: z.array(TeamMember),
  messages: z.array(TeamMessage),
  tasks: z.array(TeamTask),
});
export type TeamDetail = z.infer<typeof TeamDetail>;
export const TeamCredentialInput = z.strictObject({ code: Text.max(256), name: Text.max(80) });
export const TeamClaim = z.object({
  task: TeamTask,
  lease: z.string(),
  room: TeamRoom,
  dependencies: z.array(TeamTask),
});
export type TeamClaim = z.infer<typeof TeamClaim>;
export const TeamProgressInput = z.strictObject({
  lease: Text.max(256),
  progress: Text.max(1000),
});
export const TeamSubmitInput = TeamProgressInput.pick({ lease: true })
  .extend({ delivery: TeamDelivery })
  .strict();
export const TeamReviewInput = z.strictObject({
  action: z.enum(["approve", "revise", "cancel", "retry"]),
  note: Text.max(4000),
});

import { z } from "zod";
import { AgentName, ModelSelection, ProviderApi } from "./provider";
import { Approval } from "./approval";
import { ToolCallRecord } from "./chat";

export const CollaborationRole = z.enum(["research", "verify", "summarize"]);
export type CollaborationRole = z.infer<typeof CollaborationRole>;
export const CollaborationStatus = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "awaiting_decision",
  "accepted",
  "cancelled",
  "interrupted",
  "failed",
]);
export type CollaborationStatus = z.infer<typeof CollaborationStatus>;

export const CollaborationSources = z.object({
  agents: z.array(z.object({ id: AgentName, label: z.string() })),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      api: ProviderApi,
      models: z.array(z.string()),
      defaultModel: z.string(),
      available: z.boolean(),
      unavailableReason: z.string().optional(),
    }),
  ),
});
export type CollaborationSources = z.infer<typeof CollaborationSources>;

export const CollaborationMemberInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    agent: AgentName,
    modelSelection: ModelSelection,
  })
  .strict();
export type CollaborationMemberInput = z.infer<typeof CollaborationMemberInput>;
export const CollaborationMember = CollaborationMemberInput.extend({
  id: z.string(),
  createdAt: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
});
export type CollaborationMember = z.infer<typeof CollaborationMember>;

export const CollaborationParticipant = z
  .object({
    memberId: z.string().min(1),
    role: CollaborationRole,
  })
  .strict();
export type CollaborationParticipant = z.infer<typeof CollaborationParticipant>;
export const CollaborationRoomInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    topic: z.string().trim().min(1).max(12_000),
    participants: z.array(CollaborationParticipant).min(2).max(6),
    maxRounds: z.number().int().min(1).max(3).optional(),
  })
  .strict();
export type CollaborationRoomInput = z.infer<typeof CollaborationRoomInput>;
export const CollaborationRoom = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string(),
  participants: z.array(CollaborationParticipant),
  status: CollaborationStatus,
  round: z.number().int(),
  maxRounds: z.number().int(),
  activeMemberId: z.string().optional(),
  phase: CollaborationRole.optional(),
  pendingApprovalId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CollaborationRoom = z.infer<typeof CollaborationRoom>;

export const CollaborationMessage = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number().int().positive(),
  author: z.object({
    kind: z.enum(["owner", "agent", "system"]),
    id: z.string(),
    name: z.string(),
    agent: AgentName.optional(),
    modelSelection: ModelSelection.optional(),
  }),
  role: CollaborationRole.optional(),
  round: z.number().int(),
  content: z.string(),
  status: z.enum(["streaming", "complete", "failed", "cancelled"]),
  replyToId: z.string().optional(),
  mentionIds: z.array(z.string()),
  evidence: z.array(z.object({ url: z.string(), kind: z.enum(["tool", "citation"]) })),
  toolCalls: z.array(ToolCallRecord),
  createdAt: z.string(),
});
export type CollaborationMessage = z.infer<typeof CollaborationMessage>;

export const CollaborationMessageInput = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    content: z.string().trim().min(1).max(12_000).optional(),
    mentionIds: z.array(z.string().min(1)).max(6).optional(),
    replyToId: z.string().min(1).optional(),
  })
  .strict();
export type CollaborationMessageInput = z.infer<typeof CollaborationMessageInput>;
export const CollaborationDecisionInput = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    action: z.enum(["agree", "continue"]),
    content: z.string().trim().min(1).max(12_000).optional(),
  })
  .strict();
export type CollaborationDecisionInput = z.infer<typeof CollaborationDecisionInput>;
export const CollaborationRoomDetail = z.object({
  room: CollaborationRoom,
  members: z.array(CollaborationMember),
  messages: z.array(CollaborationMessage),
  pendingApprovals: z.array(Approval),
});
export type CollaborationRoomDetail = z.infer<typeof CollaborationRoomDetail>;

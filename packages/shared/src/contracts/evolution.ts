import { z } from "zod";

export const BehaviorVersion = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
});
export type BehaviorVersion = z.infer<typeof BehaviorVersion>;

export const EvolutionProposal = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  baseVersionId: z.string(),
  status: z.enum(["draft", "evaluated", "published", "rejected"]),
  evidenceRunIds: z.array(z.string()),
  evaluationId: z.string().nullable(),
  createdAt: z.string(),
});
export type EvolutionProposal = z.infer<typeof EvolutionProposal>;

/** 候选仅能增补任务指导，不能修改权限、工具实现与评分规则。 */
export const EvolutionProposalInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    instructions: z.string().trim().min(4).max(4000),
    evidenceRunIds: z.array(z.string().min(1).max(128)).max(10).default([]),
  })
  .strict();
export type EvolutionProposalInput = z.infer<typeof EvolutionProposalInput>;

export const EvolutionGenerateInput = z
  .object({
    evidenceRunIds: z.array(z.string().min(1).max(128)).min(1).max(5),
    allowModelCalls: z.literal(true),
  })
  .strict();
export type EvolutionGenerateInput = z.infer<typeof EvolutionGenerateInput>;

export const EvolutionPublishInput = z.object({ evaluationId: z.string().min(1) }).strict();
export const EvolutionRollbackInput = z.object({ versionId: z.string().min(1) }).strict();

export const EvolutionFeedbackInput = z
  .object({
    runId: z.string().min(1).max(128),
    rating: z.enum(["helpful", "unhelpful"]),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();
export type EvolutionFeedbackInput = z.infer<typeof EvolutionFeedbackInput>;

export const EvolutionFeedback = EvolutionFeedbackInput.extend({
  id: z.string(),
  createdAt: z.string(),
});
export type EvolutionFeedback = z.infer<typeof EvolutionFeedback>;

export const EvolutionEvidence = z.object({
  runId: z.string(),
  status: z.string(),
  summary: z.string(),
  behaviorVersionId: z.string().nullable(),
});
export type EvolutionEvidence = z.infer<typeof EvolutionEvidence>;

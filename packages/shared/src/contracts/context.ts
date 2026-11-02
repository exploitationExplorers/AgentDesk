import { z } from "zod";

export const ContextSummary = z.object({
  goal: z.string().max(1200),
  constraints: z.array(z.string().max(400)).max(12),
  decisions: z.array(z.string().max(400)).max(12),
  facts: z.array(z.string().max(400)).max(12),
  pending: z.array(z.string().max(400)).max(12),
});
export type ContextSummary = z.infer<typeof ContextSummary>;

export const ConversationContextStatus = z.object({
  conversationId: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  contextWindow: z.number(),
  capacitySource: z.enum(["configured", "default"]),
  inputBudgetTokens: z.number(),
  estimatedInputTokens: z.number(),
  historyTokens: z.number(),
  systemTokens: z.number(),
  summaryTokens: z.number(),
  estimated: z.literal(true),
  messageCount: z.number().int(),
  retainedMessages: z.number().int(),
  summarizedMessages: z.number().int(),
  summary: ContextSummary.nullable(),
  updatedAt: z.string().nullable(),
});
export type ConversationContextStatus = z.infer<typeof ConversationContextStatus>;

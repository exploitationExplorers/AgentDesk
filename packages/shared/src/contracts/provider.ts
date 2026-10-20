import { z } from "zod";

export const ProviderApi = z.enum(["openai-completions", "anthropic-messages"]);
export type ProviderApi = z.infer<typeof ProviderApi>;

export const ProviderSource = z.enum(["manual", "dotenv", "cc-switch"]);
export type ProviderSource = z.infer<typeof ProviderSource>;

export const Provider = z.object({
  id: z.string(),
  name: z.string().min(1),
  api: ProviderApi,
  baseUrl: z.string().url(),
  models: z.array(z.string()).min(1),
  defaultModel: z.string(),
  source: ProviderSource,
  enabled: z.boolean(),
  hasKey: z.boolean(),
  createdAt: z.string(),
});
export type Provider = z.infer<typeof Provider>;

export const ProviderInput = Provider.pick({
  name: true,
  api: true,
  baseUrl: true,
  models: true,
  defaultModel: true,
  source: true,
  enabled: true,
}).extend({ apiKey: z.string().optional() });
export type ProviderInput = z.infer<typeof ProviderInput>;

/** 导入向导的候选项：密钥仅以掩码形式返回给 UI，确认时由 sidecar 重新读取原文件。 */
export const ProviderCandidate = z.object({
  candidateId: z.string(),
  name: z.string(),
  api: ProviderApi,
  baseUrl: z.string(),
  model: z.string().optional(),
  maskedKey: z.string(),
  source: ProviderSource,
  origin: z.string(),
});
export type ProviderCandidate = z.infer<typeof ProviderCandidate>;

export const AgentName = z.enum(["orchestrator", "project", "deploy", "research", "code"]);
export type AgentName = z.infer<typeof AgentName>;

export const AgentModelBinding = z.object({
  agent: AgentName,
  providerId: z.string(),
  model: z.string(),
  fallbackProviderIds: z.array(z.string()).default([]),
});
export type AgentModelBinding = z.infer<typeof AgentModelBinding>;

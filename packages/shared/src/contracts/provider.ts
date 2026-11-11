import { z } from "zod";

export const ProviderApi = z.enum(["openai-completions", "anthropic-messages"]);
export type ProviderApi = z.infer<typeof ProviderApi>;

export const ProviderSource = z.enum(["manual", "dotenv", "cc-switch"]);
export type ProviderSource = z.infer<typeof ProviderSource>;

/** 按模型配置容量，未配置时采用明确标注的保守默认预算。 */
export const ModelLimits = z
  .object({
    contextWindow: z.number().int().min(4096).max(2_000_000),
    maxOutputTokens: z.number().int().min(256).max(200_000),
  })
  .refine((value) => value.maxOutputTokens < value.contextWindow / 2, {
    message: "输出上限必须小于上下文窗口的一半",
  });
export type ModelLimits = z.infer<typeof ModelLimits>;

export const Provider = z.object({
  id: z.string(),
  name: z.string().min(1),
  api: ProviderApi,
  baseUrl: z.string().url(),
  models: z.array(z.string()).min(1),
  defaultModel: z.string(),
  modelLimits: z.record(z.string(), ModelLimits).optional(),
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
  modelLimits: true,
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

export const AgentName = z.enum([
  "orchestrator",
  "project",
  "deploy",
  "research",
  "code",
  "reviewer",
]);
export type AgentName = z.infer<typeof AgentName>;

export const AgentModelBinding = z.object({
  agent: AgentName,
  providerId: z.string(),
  model: z.string(),
  fallbackProviderIds: z.array(z.string()).default([]),
});
export type AgentModelBinding = z.infer<typeof AgentModelBinding>;

/**
 * 模型思考强度（与 pi-ai ThinkingLevel / Codex model_reasoning_effort 对齐）。
 * UI 三档 simple/medium/deep 分别映射到 low/medium/high。
 */
export const ReasoningEffort = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** 单次会话请求的模型选择，不修改全局 Agent 绑定。 */
export const ModelSelection = z.object({
  providerId: z.string().min(1),
  model: z.string().trim().min(1).max(256),
  reasoningEffort: ReasoningEffort.optional(),
});
export type ModelSelection = z.infer<typeof ModelSelection>;

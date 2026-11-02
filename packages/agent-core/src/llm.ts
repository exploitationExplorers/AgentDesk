import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentName, ModelLimits, ModelSelection, ProviderApi } from "@agentdesk/shared";

export const DEFAULT_CONTEXT_WINDOW = 32_768;

export interface ProviderEndpoint {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  modelLimits?: Record<string, ModelLimits>;
}

/** 一个可直接调用的模型：pi-ai Model + 解密后的 key。 */
export interface ResolvedModel {
  providerId: string;
  providerName: string;
  model: Model<Api>;
  apiKey: string;
  capacitySource?: "configured" | "default";
}

/** 按 Agent 解析出"主模型 + 备用模型"列表，主模型失败时依次切换。 */
export interface ModelResolver {
  resolve(agent: AgentName, selection?: ModelSelection): Promise<ResolvedModel[]>;
}

export function buildModel(endpoint: ProviderEndpoint, modelId: string): Model<Api> {
  const limits = endpoint.modelLimits?.[modelId];
  return {
    id: modelId,
    name: modelId,
    api: endpoint.api,
    provider: endpoint.name,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: limits?.maxOutputTokens ?? 4_096,
  };
}

import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentName, ProviderApi } from "@agentdesk/shared";

export interface ProviderEndpoint {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
}

/** 一个可直接调用的模型：pi-ai Model + 解密后的 key。 */
export interface ResolvedModel {
  providerId: string;
  providerName: string;
  model: Model<Api>;
  apiKey: string;
}

/** 按 Agent 解析出"主模型 + 备用模型"列表，主模型失败时依次切换。 */
export interface ModelResolver {
  resolve(agent: AgentName): Promise<ResolvedModel[]>;
}

export function buildModel(endpoint: ProviderEndpoint, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: endpoint.api,
    provider: endpoint.name,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

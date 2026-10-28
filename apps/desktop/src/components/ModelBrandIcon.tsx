import { ModelIcon, ProviderIcon } from "@lobehub/icons";
import type { ProviderApi } from "@agentdesk/shared";

const BRANDS: Array<[RegExp, string]> = [
  [/anthropic|claude/, "anthropic"],
  [/deepseek/, "deepseek"],
  [/qwen|dashscope|aliyuncs/, "qwen"],
  [/gemini|generativelanguage|googleapis/, "google"],
  [/openrouter/, "openrouter"],
  [/groq/, "groq"],
  [/moonshot|\bkimi\b/, "moonshot"],
  [/bigmodel|zhipu|\bglm\b/, "zhipu"],
  [/doubao|volces|volcengine/, "doubao"],
  [/ollama/, "ollama"],
  [/mistral/, "mistral"],
  [/siliconflow|siliconcloud/, "siliconcloud"],
  [/minimax/, "minimax"],
  [/cohere/, "cohere"],
  [/perplexity/, "perplexity"],
  [/x\.ai|\bgrok\b/, "xai"],
  [/\bgpt\b|gpt-|openai|\bo1\b|\bo3\b|\bo4\b/, "openai"],
];

function resolveBrand(model?: string, baseUrl?: string, api?: ProviderApi) {
  const text = `${model ?? ""} ${baseUrl ?? ""}`.toLowerCase();
  if (api === "anthropic-messages") return "anthropic";
  return BRANDS.find(([pattern]) => pattern.test(text))?.[1];
}

/** 按模型 ID、接口地址识别品牌，使用 LobeHub 图标。认不出时退回按模型名匹配。 */
export function ModelBrandIcon({
  model,
  baseUrl,
  api,
  size = 16,
}: {
  model?: string;
  baseUrl?: string;
  api?: ProviderApi;
  size?: number;
}) {
  if (!model && !baseUrl) return null;
  const provider = resolveBrand(model, baseUrl, api);
  if (provider) return <ProviderIcon provider={provider} size={size} type="avatar" />;
  if (!model) return null;
  return <ModelIcon model={model} size={size} type="avatar" />;
}

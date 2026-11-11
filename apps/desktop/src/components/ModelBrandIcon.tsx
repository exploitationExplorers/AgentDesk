import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import * as anthropicStyle from "@lobehub/icons/es/Anthropic/style";
import CohereIcon from "@lobehub/icons/es/Cohere/components/Mono";
import * as cohereStyle from "@lobehub/icons/es/Cohere/style";
import DeepSeekIcon from "@lobehub/icons/es/DeepSeek/components/Mono";
import * as deepSeekStyle from "@lobehub/icons/es/DeepSeek/style";
import DoubaoIcon from "@lobehub/icons/es/Doubao/components/Color";
import * as doubaoStyle from "@lobehub/icons/es/Doubao/style";
import GoogleIcon from "@lobehub/icons/es/Google/components/Color";
import * as googleStyle from "@lobehub/icons/es/Google/style";
import GroqIcon from "@lobehub/icons/es/Groq/components/Mono";
import * as groqStyle from "@lobehub/icons/es/Groq/style";
import MinimaxIcon from "@lobehub/icons/es/Minimax/components/Mono";
import * as minimaxStyle from "@lobehub/icons/es/Minimax/style";
import MistralIcon from "@lobehub/icons/es/Mistral/components/Mono";
import * as mistralStyle from "@lobehub/icons/es/Mistral/style";
import MoonshotIcon from "@lobehub/icons/es/Moonshot/components/Mono";
import * as moonshotStyle from "@lobehub/icons/es/Moonshot/style";
import OllamaIcon from "@lobehub/icons/es/Ollama/components/Mono";
import * as ollamaStyle from "@lobehub/icons/es/Ollama/style";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import * as openAIStyle from "@lobehub/icons/es/OpenAI/style";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import * as openRouterStyle from "@lobehub/icons/es/OpenRouter/style";
import PerplexityIcon from "@lobehub/icons/es/Perplexity/components/Mono";
import * as perplexityStyle from "@lobehub/icons/es/Perplexity/style";
import QwenIcon from "@lobehub/icons/es/Qwen/components/Mono";
import * as qwenStyle from "@lobehub/icons/es/Qwen/style";
import SiliconCloudIcon from "@lobehub/icons/es/SiliconCloud/components/Mono";
import * as siliconCloudStyle from "@lobehub/icons/es/SiliconCloud/style";
import XAIIcon from "@lobehub/icons/es/XAI/components/Mono";
import * as xaiStyle from "@lobehub/icons/es/XAI/style";
import ZhipuIcon from "@lobehub/icons/es/Zhipu/components/Mono";
import * as zhipuStyle from "@lobehub/icons/es/Zhipu/style";
import { Cpu } from "lucide-react";
import type { ProviderApi } from "@agentdesk/shared";

interface BrandStyle {
  TITLE: string;
  AVATAR_BACKGROUND: string;
  AVATAR_COLOR: string;
  AVATAR_ICON_MULTIPLE: number;
}

// 只导入已支持品牌的 SVG，避免通用注册表拉入所有图标及其 UI 依赖。
const BRANDS: Array<[RegExp, typeof OpenAIIcon, BrandStyle]> = [
  [/anthropic|claude/, AnthropicIcon, anthropicStyle],
  [/deepseek/, DeepSeekIcon, deepSeekStyle],
  [/qwen|dashscope|aliyuncs/, QwenIcon, qwenStyle],
  [/gemini|generativelanguage|googleapis/, GoogleIcon, googleStyle],
  [/openrouter/, OpenRouterIcon, openRouterStyle],
  [/groq/, GroqIcon, groqStyle],
  [/moonshot|\bkimi\b/, MoonshotIcon, moonshotStyle],
  [/bigmodel|zhipu|\bglm\b/, ZhipuIcon, zhipuStyle],
  [/doubao|volces|volcengine/, DoubaoIcon, doubaoStyle],
  [/ollama/, OllamaIcon, ollamaStyle],
  [/mistral/, MistralIcon, mistralStyle],
  [/siliconflow|siliconcloud/, SiliconCloudIcon, siliconCloudStyle],
  [/minimax/, MinimaxIcon, minimaxStyle],
  [/cohere/, CohereIcon, cohereStyle],
  [/perplexity/, PerplexityIcon, perplexityStyle],
  [/x\.ai|\bgrok\b/, XAIIcon, xaiStyle],
  [/\bgpt\b|gpt-|openai|\bo1\b|\bo3\b|\bo4\b/, OpenAIIcon, openAIStyle],
];

function resolveBrand(model?: string, baseUrl?: string, api?: ProviderApi) {
  const text = `${model ?? ""} ${baseUrl ?? ""}`.toLowerCase();
  if (api === "anthropic-messages") return BRANDS[0];
  return BRANDS.find(([pattern]) => pattern.test(text));
}

/** 按模型 ID、接口地址识别品牌，未知模型使用通用图标。 */
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
  const brand = resolveBrand(model, baseUrl, api);
  if (!brand) return <Cpu size={size} aria-label={model ?? "自定义模型"} />;
  const [, Icon, style] = brand;
  return (
    <span
      aria-label={style.TITLE}
      role="img"
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        background: style.AVATAR_BACKGROUND,
        color: style.AVATAR_COLOR,
      }}
    >
      <Icon size={size * style.AVATAR_ICON_MULTIPLE} aria-hidden="true" />
    </span>
  );
}

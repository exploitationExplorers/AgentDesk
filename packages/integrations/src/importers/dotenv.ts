import { readFile } from "node:fs/promises";
import type { ProviderApi } from "@agentdesk/shared";
import type { RawProviderCandidate } from "./types";

export function parseDotenv(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]] = value;
  }
  return result;
}

/** 已知前缀的默认地址；未知前缀只有在 .env 里给出 BASE_URL 时才会导入。 */
const KNOWN_BASES: Record<string, { baseUrl: string; api: ProviderApi; name: string }> = {
  OPENAI: { baseUrl: "https://api.openai.com/v1", api: "openai-completions", name: "OpenAI" },
  ANTHROPIC: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", name: "Anthropic" },
  DEEPSEEK: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", name: "DeepSeek" },
  DASHSCOPE: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    name: "通义千问",
  },
  QWEN: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    name: "通义千问",
  },
  MOONSHOT: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", name: "Moonshot" },
  ZHIPU: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    name: "智谱",
  },
  SILICONFLOW: {
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    name: "SiliconFlow",
  },
  OPENROUTER: {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    name: "OpenRouter",
  },
  GROQ: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", name: "Groq" },
  XAI: { baseUrl: "https://api.x.ai/v1", api: "openai-completions", name: "xAI" },
};

/** 明确不是 LLM 的 key，避免误导入 */
const NON_LLM = [
  "LANGSMITH",
  "LANGCHAIN",
  "TAVILY",
  "SERPER",
  "PINECONE",
  "GITHUB",
  "GITEE",
  "GITLAB",
  "LANGFUSE",
  "RERANK",
  "EMBEDDING",
  "JINA",
];

function pick(env: Record<string, string>, prefix: string, suffixes: string[]): string | undefined {
  for (const s of suffixes) {
    const v = env[`${prefix}${s}`];
    if (v) return v;
  }
  return undefined;
}

export function candidatesFromDotenv(
  env: Record<string, string>,
  origin: string,
): RawProviderCandidate[] {
  const out: RawProviderCandidate[] = [];
  for (const [key, apiKey] of Object.entries(env)) {
    const match = /^(.*?)(?:_)?(?:API_KEY|AUTH_TOKEN|APIKEY)$/.exec(key);
    if (!match || !apiKey || apiKey.length < 8) continue;
    const prefix = match[1] ? `${match[1]}_` : "";
    const name = (match[1] ?? "").toUpperCase();
    if (NON_LLM.some((n) => name.includes(n))) continue;

    const known = Object.entries(KNOWN_BASES).find(
      ([k]) => name === k || name.startsWith(`${k}_`),
    )?.[1];
    const baseUrl =
      pick(env, prefix, ["BASE_URL", "API_BASE", "BASE", "ENDPOINT", "URL", "API_URL"]) ??
      known?.baseUrl;
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) continue;

    const api: ProviderApi =
      known?.api ??
      (/ANTHROPIC|CLAUDE/.test(name) || /anthropic/i.test(baseUrl)
        ? "anthropic-messages"
        : "openai-completions");
    out.push({
      candidateId: `dotenv:${origin}:${key}`,
      name: known?.name ?? (name ? name.replace(/_/g, " ") : "LLM"),
      api,
      baseUrl,
      model: pick(env, prefix, ["MODEL", "MODEL_NAME", "CHAT_MODEL", "DEFAULT_MODEL"]),
      apiKey,
      source: "dotenv",
      origin,
    });
  }
  return out;
}

export async function importFromDotenvFile(path: string): Promise<RawProviderCandidate[]> {
  const source = await readFile(path, "utf8");
  return candidatesFromDotenv(parseDotenv(source), path);
}

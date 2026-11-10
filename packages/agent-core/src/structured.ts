import { complete, type Usage, type UserMessage } from "@mariozechner/pi-ai";
import type { z } from "zod";
import { DEFAULT_CONTEXT_WINDOW, type ResolvedModel } from "./llm";
import { estimateMessageTokens, estimateTokens, inputBudget } from "./context";
import { maskJson, maskText, unmaskText, type MaskStore } from "./masking";

export interface CompleteOptions {
  models: ResolvedModel[];
  systemPrompt: string;
  prompt: string | UserMessage["content"];
  signal?: AbortSignal;
  maxTokens?: number;
  /** 可选：发给模型前脱敏、拿到回复后换回真实值。 */
  mask?: MaskStore;
  /** 每次请求的供应商用量；包含解析重试和备用模型返回的用量。 */
  onUsage?: (usage: Usage, model: ResolvedModel, estimatedInputTokens: number) => void;
}

/** 普通单轮补全，带备用模型切换。 */
export async function completeText(options: CompleteOptions): Promise<string> {
  let lastError = "没有可用的模型";
  const systemPrompt = options.mask
    ? maskText(options.systemPrompt, options.mask)
    : options.systemPrompt;
  const prompt = options.mask ? maskJson(options.prompt, options.mask) : options.prompt;
  const messages: UserMessage[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateMessageTokens(messages);
  for (const candidate of options.models) {
    options.signal?.throwIfAborted();
    const maxTokens = Math.min(
      options.maxTokens ?? candidate.model.maxTokens,
      candidate.model.maxTokens,
    );
    if (
      estimatedInputTokens >
      inputBudget(candidate.model.contextWindow || DEFAULT_CONTEXT_WINDOW, maxTokens)
    ) {
      lastError = `上下文超出 ${candidate.model.id} 的输入预算（估算 ${estimatedInputTokens} tokens），请缩短输入或配置更大的模型窗口`;
      continue;
    }
    const message = await complete(
      candidate.model,
      {
        systemPrompt,
        messages,
      },
      { apiKey: candidate.apiKey, signal: options.signal, maxTokens },
    );
    options.onUsage?.(message.usage, candidate, estimatedInputTokens);
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      const text = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      return options.mask ? unmaskText(text, options.mask) : text;
    }
    lastError = message.errorMessage ?? lastError;
  }
  throw new Error(`模型调用失败：${lastError}`);
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("模型输出中没有 JSON");
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

/** 要求模型输出 JSON 并用 zod 校验，失败时把错误回传给模型重试一次。 */
export async function completeStructured<T extends z.ZodType>(
  options: CompleteOptions & { schema: T },
): Promise<z.infer<T>> {
  const system = `${options.systemPrompt}\n\n只输出 JSON，不要输出任何解释。`;
  let prompt = options.prompt;
  let lastReason = "模型没有返回可解析的 JSON";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await completeText({ ...options, systemPrompt: system, prompt });
    try {
      return options.schema.parse(extractJson(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastReason = reason;
      const hint = `\n\n上次输出无法解析：${reason}\n请严格输出合法 JSON。`;
      prompt =
        typeof options.prompt === "string"
          ? `${options.prompt}${hint}`
          : [...options.prompt, { type: "text", text: hint }];
    }
  }
  throw new Error(`模型未能输出合法的结构化结果（${lastReason}）`);
}

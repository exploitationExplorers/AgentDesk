import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { z } from "zod";
import type { ResolvedModel } from "./llm";

export interface CompleteOptions {
  models: ResolvedModel[];
  systemPrompt: string;
  prompt: string | UserMessage["content"];
  signal?: AbortSignal;
  maxTokens?: number;
}

/** 普通单轮补全，带备用模型切换。 */
export async function completeText(options: CompleteOptions): Promise<string> {
  let lastError = "没有可用的模型";
  for (const candidate of options.models) {
    const message = await complete(
      candidate.model,
      {
        systemPrompt: options.systemPrompt,
        messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
      },
      { apiKey: candidate.apiKey, signal: options.signal, maxTokens: options.maxTokens },
    );
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      return message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await completeText({ ...options, systemPrompt: system, prompt });
    try {
      return options.schema.parse(extractJson(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const hint = `\n\n上次输出无法解析：${reason}\n请严格输出合法 JSON。`;
      prompt =
        typeof options.prompt === "string"
          ? `${options.prompt}${hint}`
          : [...options.prompt, { type: "text", text: hint }];
    }
  }
  throw new Error("模型未能输出合法的结构化结果");
}

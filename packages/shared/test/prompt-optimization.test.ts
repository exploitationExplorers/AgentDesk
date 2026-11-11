import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_OPTIMIZATION_CHARS,
  PromptOptimizationRequest,
  PromptOptimizationResponse,
} from "../src";

const request = {
  text: "修复登录失败，保持现有接口兼容。",
  agent: "code",
  modelSelection: { providerId: "provider-1", model: "model-1" },
};

describe("提示词优化契约", () => {
  it("保留草稿的空白、代码和变量原文", () => {
    const text = "\n  检查 {{file}}\n```ts\nconst value = 1;\n```\n";
    expect(PromptOptimizationRequest.parse({ ...request, text }).text).toBe(text);
    expect(PromptOptimizationResponse.parse({ optimizedText: text }).optimizedText).toBe(text);
  });

  it.each(["", "  ", "\n\t\r", "\u3000"])("拒绝空白输入和输出：%j", (text) => {
    expect(PromptOptimizationRequest.safeParse({ ...request, text }).success).toBe(false);
    expect(PromptOptimizationResponse.safeParse({ optimizedText: text }).success).toBe(false);
  });

  it("明确限制输入和输出长度，不静默裁剪", () => {
    const text = "x".repeat(MAX_PROMPT_OPTIMIZATION_CHARS);
    expect(PromptOptimizationRequest.parse({ ...request, text }).text).toHaveLength(
      MAX_PROMPT_OPTIMIZATION_CHARS,
    );
    expect(PromptOptimizationRequest.safeParse({ ...request, text: `${text}x` }).success).toBe(
      false,
    );
    expect(PromptOptimizationResponse.safeParse({ optimizedText: `${text}x` }).success).toBe(false);
  });

  it("必须提供明确模型和有效 Agent", () => {
    expect(
      PromptOptimizationRequest.safeParse({ ...request, modelSelection: undefined }).success,
    ).toBe(false);
    expect(PromptOptimizationRequest.safeParse({ ...request, agent: "unknown" }).success).toBe(
      false,
    );
    expect(
      PromptOptimizationRequest.safeParse({
        ...request,
        modelSelection: { providerId: "", model: "model-1" },
      }).success,
    ).toBe(false);
  });
});

import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModel,
  completeText,
  completeTextResult,
  createMaskStore,
  type ResolvedModel,
} from "../src";

let faux: FauxProviderRegistration;
beforeEach(() => {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
});
afterEach(() => {
  faux.unregister();
  vi.unstubAllGlobals();
});

function candidate(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "faux",
    providerName: "faux",
    model: faux.getModel(),
    apiKey: "test",
    ...overrides,
  };
}

describe("单轮文本结果", () => {
  it("返回截断原因，且只调用一个明确模型一次", async () => {
    faux.setResponses([fauxAssistantMessage("尚未完整输出", { stopReason: "length" })]);
    const onUsage = vi.fn();
    const result = await completeTextResult({
      models: [candidate()],
      systemPrompt: "只改写提示词",
      prompt: "修复问题",
      maxTokens: 256,
      onUsage,
    });
    expect(result).toEqual({ text: "尚未完整输出", stopReason: "length" });
    expect(faux.state.callCount).toBe(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]?.[0].totalTokens).toBeGreaterThan(0);
  });

  it("将思考强度传给通用模型适配层，并尊重模型输出上限", async () => {
    faux.setResponses([
      (_context, options, _state, model) => {
        expect((options as SimpleStreamOptions).reasoning).toBe("high");
        expect(options?.maxTokens).toBe(256);
        expect(model.maxTokens).toBe(256);
        expect(options?.maxRetries).toBe(0);
        return fauxAssistantMessage("优化结果");
      },
    ]);
    const result = await completeTextResult({
      models: [
        candidate({
          reasoningEffort: "high",
          model: { ...faux.getModel(), maxTokens: 512 },
        }),
      ],
      systemPrompt: "只改写提示词",
      prompt: "修复问题",
      maxTokens: 256,
      maxRetries: 0,
    });
    expect(result).toEqual({ text: "优化结果", stopReason: "stop" });
  });

  it("旧字符串接口保留原先的选项行为", async () => {
    faux.setResponses([
      (_context, options) => {
        expect(options).not.toHaveProperty("reasoning");
        return fauxAssistantMessage("旧接口结果");
      },
    ]);
    await expect(
      completeText({
        models: [candidate({ reasoningEffort: "high" })],
        systemPrompt: "整理目标",
        prompt: "现有任务",
      }),
    ).resolves.toBe("旧接口结果");
  });

  it.each([256, 1024, 2047, 2048])(
    "真实 Anthropic 适配器在 %i token 预算下构造有效 thinking 参数且不扩大上限",
    async (maxTokens) => {
      const payloads: Array<{
        max_tokens: number;
        thinking: { type: string; budget_tokens?: number };
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
          payloads.push(JSON.parse(String(body)));
          const events = [
            {
              type: "message_start",
              message: {
                id: "msg_test",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-sonnet-4-5-20250929",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 8, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "优化结果" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }),
      );
      const result = await completeTextResult({
        models: [
          {
            providerId: "anthropic",
            providerName: "anthropic",
            apiKey: "test-key",
            reasoningEffort: "high",
            model: buildModel(
              {
                id: "anthropic",
                name: "anthropic",
                api: "anthropic-messages",
                baseUrl: "https://provider.invalid",
              },
              "claude-sonnet-4-5-20250929",
              { reasoning: true },
            ),
          },
        ],
        systemPrompt: "只改写提示词",
        prompt: "修复问题",
        maxTokens,
        maxRetries: 0,
      });
      expect(result).toEqual({ text: "优化结果", stopReason: "stop" });
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.max_tokens).toBe(maxTokens);
      if (maxTokens < 2048) {
        expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
      } else {
        expect(payloads[0]?.thinking.type).toBe("enabled");
        expect(payloads[0]?.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
        expect(payloads[0]?.thinking.budget_tokens).toBeLessThan(maxTokens);
      }
    },
  );

  it("新接口沿用脱敏和还原，不将私密字面量发给模型", async () => {
    const original = "保留邮箱 developer@example.com";
    faux.setResponses([
      (context) => {
        const prompt = context.messages[0]?.content;
        expect(typeof prompt).toBe("string");
        expect(prompt).not.toContain("developer@example.com");
        expect(prompt).toContain("{{MASK_EMAIL_");
        return fauxAssistantMessage(String(prompt));
      },
    ]);
    const result = await completeTextResult({
      models: [candidate()],
      systemPrompt: "保留原文",
      prompt: original,
      mask: createMaskStore(),
    });
    expect(result.text).toBe(original);
  });

  it("请求开始前取消时不调用供应商", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      completeTextResult({
        models: [candidate()],
        systemPrompt: "整理目标",
        prompt: "原文",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(faux.state.callCount).toBe(0);
  });

  it("供应商返回后取消仍拒绝结果，并保留已发生用量", async () => {
    faux.setResponses([fauxAssistantMessage("迟到的结果")]);
    const controller = new AbortController();
    const reason = new Error("不再需要此结果");
    const onUsage = vi.fn(() => controller.abort(reason));
    await expect(
      completeTextResult({
        models: [candidate(), candidate({ providerId: "fallback" })],
        systemPrompt: "整理目标",
        prompt: "原文",
        signal: controller.signal,
        onUsage,
      }),
    ).rejects.toBe(reason);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(faux.state.callCount).toBe(1);
  });

  it("供应商错误只遍历调用方明确给定的候选", async () => {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "供应商不可用" }),
      fauxAssistantMessage("备用结果"),
    ]);
    await expect(
      completeTextResult({
        models: [candidate()],
        systemPrompt: "整理目标",
        prompt: "原文",
      }),
    ).rejects.toThrow("供应商不可用");
    expect(faux.state.callCount).toBe(1);
    expect(faux.getPendingResponseCount()).toBe(1);
  });
});

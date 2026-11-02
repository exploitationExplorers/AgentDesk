import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
  type FauxProviderRegistration,
  type Message,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentStreamEvent } from "@agentdesk/shared";
import {
  buildModel,
  completeStructured,
  completeText,
  DEFAULT_CONTEXT_WINDOW,
  ESTIMATED_IMAGE_TOKENS,
  estimateMessageTokens,
  estimateTokens,
  runAgent,
} from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => faux?.unregister());

describe("模型预算与真实用量", () => {
  it("带图消息按图片预算估算，不把传输编码当作文本", () => {
    const message = (data: string): Message => ({
      role: "user",
      timestamp: 0,
      content: [
        { type: "text", text: "找出按钮" },
        { type: "image", data, mimeType: "image/png" },
      ],
    });
    const small = estimateMessageTokens([message("AAAA")]);
    const large = estimateMessageTokens([message("A".repeat(800000))]);
    expect(large).toBe(small);
    expect(large).toBeGreaterThan(ESTIMATED_IMAGE_TOKENS);
    expect(large).toBeLessThan(ESTIMATED_IMAGE_TOKENS + 100);
    const toolImage: Message = {
      role: "toolResult",
      toolName: "browser.screenshot",
      toolCallId: "screenshot",
      timestamp: 0,
      content: [{ type: "image", data: "A".repeat(800000), mimeType: "image/png" }],
      isError: false,
    };
    expect(estimateMessageTokens([toolImage])).toBeLessThan(ESTIMATED_IMAGE_TOKENS + 100);
    expect(estimateMessageTokens([message("AAAA"), toolImage])).toBeGreaterThan(
      ESTIMATED_IMAGE_TOKENS * 2,
    );
    expect(
      estimateMessageTokens([{ role: "user", timestamp: 0, content: "资料".repeat(5000) }]),
    ).toBeGreaterThan(10000);
  });

  it("默认窗口下的结构化视觉请求可以发送大截图", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    const screenshot = "A".repeat(800000);
    let received = false;
    faux.setResponses([
      (context) => {
        received = JSON.stringify(context.messages).includes(screenshot);
        return fauxAssistantMessage('{"x":120,"y":80}');
      },
    ]);
    const result = await completeStructured({
      models: [
        {
          providerId: "faux",
          providerName: "faux",
          model: { ...faux.getModel(), contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: 4096 },
          apiKey: "test",
        },
      ],
      systemPrompt: "根据截图定位按钮",
      prompt: [
        { type: "text", text: "点击确认按钮" },
        { type: "image", data: screenshot, mimeType: "image/png" },
      ],
      schema: z.object({ x: z.number(), y: z.number() }),
      maxTokens: 256,
    });
    expect(result).toEqual({ x: 120, y: 80 });
    expect(received).toBe(true);
    expect(faux.state.callCount).toBe(1);
  });

  it("按模型配置容量，未知模型使用保守默认值", () => {
    const endpoint = {
      id: "test",
      name: "test",
      api: "openai-completions" as const,
      baseUrl: "https://example.invalid",
      modelLimits: { large: { contextWindow: 200000, maxOutputTokens: 20000 } },
    };
    expect(buildModel(endpoint, "large").contextWindow).toBe(200000);
    expect(buildModel(endpoint, "large").maxTokens).toBe(20000);
    expect(buildModel(endpoint, "unknown").contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(estimateTokens("中文上下文")).toBe(5);
  });

  it("真实usage单独上报，不拿估算值冒充实际用量", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    faux.setResponses([fauxAssistantMessage(fauxText("完成"))]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({
      definition: {
        name: "code",
        title: "Code",
        description: "Code",
        systemPrompt: "帮助用户",
        tools: [],
      },
      tools: [],
      models: [
        { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
      ],
      messages: [],
      emit: (event) => events.push(event),
      requestApproval: async () => true,
    });
    const response = result.messages.at(-1);
    if (response?.role !== "assistant") throw new Error("缺少模型回复");
    const event = events.find((event) => event.type === "model_usage");
    expect(event).toMatchObject({
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      cacheReadTokens: response.usage.cacheRead,
      cacheWriteTokens: response.usage.cacheWrite,
      totalTokens: response.usage.totalTokens,
    });
    expect(event?.estimatedInputTokens).not.toBe(response.usage.totalTokens);
  });

  it("完整prompt超过输入预算时不发起模型请求", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    faux.setResponses([fauxAssistantMessage(fauxText("不应调用"))]);
    await expect(
      runAgent({
        definition: {
          name: "code",
          title: "Code",
          description: "Code",
          systemPrompt: "规则".repeat(5000),
          tools: [],
        },
        tools: [],
        models: [
          {
            providerId: "faux",
            providerName: "faux",
            model: { ...faux.getModel(), contextWindow: 8192, maxTokens: 1024 },
            apiKey: "test",
          },
        ],
        messages: [],
        emit: () => {},
        requestApproval: async () => true,
      }),
    ).rejects.toThrow(/上下文超出/);
    expect(faux.state.callCount).toBe(0);
  });

  it("结构化重试分别报告真实用量，使用配置的输出上限", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    const requestedLimits: Array<number | undefined> = [];
    faux.setResponses([
      (_context, options) => {
        requestedLimits.push(options?.maxTokens);
        return fauxAssistantMessage("not JSON");
      },
      (_context, options) => {
        requestedLimits.push(options?.maxTokens);
        return fauxAssistantMessage('{"goal":"完成"}');
      },
    ]);
    const onUsage = vi.fn();
    const result = await completeStructured({
      models: [
        {
          providerId: "faux",
          providerName: "faux",
          model: { ...faux.getModel(), maxTokens: 1024 },
          apiKey: "test",
        },
      ],
      systemPrompt: "整理目标",
      prompt: "完成工作",
      schema: z.object({ goal: z.string() }),
      maxTokens: 3000,
      onUsage,
    });
    expect(result.goal).toBe("完成");
    expect(requestedLimits).toEqual([1024, 1024]);
    expect(onUsage).toHaveBeenCalledTimes(2);
    for (const [usage, model, estimated] of onUsage.mock.calls) {
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(model.providerId).toBe("faux");
      expect(estimated).toBeGreaterThan(0);
    }
  });

  it("单轮补全对完整请求做预算检查并跳过过小的备用模型", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    const onUsage = vi.fn();
    await expect(
      completeText({
        models: [
          {
            providerId: "faux",
            providerName: "faux",
            model: { ...faux.getModel(), contextWindow: 4096, maxTokens: 1024 },
            apiKey: "test",
          },
        ],
        systemPrompt: "检查资料",
        prompt: "很长的资料".repeat(2000),
        onUsage,
      }),
    ).rejects.toThrow(/上下文超出/);
    expect(faux.state.callCount).toBe(0);
    expect(onUsage).not.toHaveBeenCalled();
  });
});

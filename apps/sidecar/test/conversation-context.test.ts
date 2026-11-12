import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  buildModel,
  createMaskStore,
  estimateTokens,
  runAgent,
  unmaskText,
  type ModelResolver,
} from "@agentdesk/agent-core";
import type { AgentStreamEvent, ChatMessage } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { ConversationStore } from "../src/services/conversation-store";
import {
  ConversationContextService,
  type ContextServiceOptions,
  type SummaryInput,
} from "../src/services/conversation-context";
let database: DbHandle | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(() => {
  database?.close();
  faux?.unregister();
});
function setup(
  options: ContextServiceOptions & {
    window?: number;
  } = {},
) {
  database = openDatabase(":memory:");
  const store = new ConversationStore(database.db);
  const model = buildModel(
    {
      id: "test",
      name: "test",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      modelLimits: { test: { contextWindow: options.window ?? 8192, maxOutputTokens: 1024 } },
    },
    "test",
  );
  const resolver: ModelResolver = {
    resolve: async () => [
      {
        providerId: "test",
        providerName: "test",
        model,
        apiKey: "test",
        capacitySource: "configured",
      },
    ],
  };
  const summarize = vi.fn(
    options.summarize ??
      (async ({ previous }: SummaryInput) =>
        previous ?? {
          goal: "开发项目",
          constraints: ["保留原有数据"],
          decisions: ["使用现有工具"],
          facts: ["已经验证登录"],
          pending: ["补充测试"],
        }),
  );
  const service = new ConversationContextService(database.db, resolver, { ...options, summarize });
  const add = async (index: number, content = `第 ${index} 条消息`) => {
    const message: ChatMessage = {
      id: `m${index}`,
      conversationId: "conversation",
      role: index % 2 ? "assistant" : "user",
      content,
      toolCalls: [],
      agent: null,
      createdAt: new Date(1700000000000 + index * 1000).toISOString(),
    };
    await store.insertMessage(message);
    return message;
  };
  return { store, service, add, summarize, resolver };
}
describe("会话上下文预算与摘要", () => {
  it("按当前输入和系统内容的总预算压缩，仍保留最新完整问答", async () => {
    const { service, add, store } = setup();
    for (let i = 0; i < 12; i++) add(i, `第 ${i} 条：${"资料".repeat(300)}`);
    const original = await store.listMessages("conversation");
    const result = await service.prepare({
      conversationId: "conversation",
      userMessage: "当前请求".repeat(250),
      systemContext: "项目约束".repeat(100),
    });
    expect(result.compacted).toBe(true);
    expect(result.status.retainedMessages).toBeLessThan(6);
    expect(result.status.retainedMessages).toBeGreaterThanOrEqual(2);
    expect(result.status.estimatedInputTokens).toBeLessThanOrEqual(result.status.inputBudgetTokens);
    expect(result.history.slice(-2)).toEqual(store.toPiMessages(original.slice(-2)));
    expect(await store.listMessages("conversation")).toEqual(original);
  });
  it("首轮摘要偏长时继续增量压缩，完成前不发布中间结果", async () => {
    const { service, add, summarize, store } = setup();
    for (let i = 0; i < 12; i++) add(i, `第 ${i} 条：${"资".repeat(490)}`);
    const longSummary = {
      goal: "目标".repeat(500),
      constraints: ["约束".repeat(200)],
      facts: ["事实".repeat(200)],
      decisions: [],
      pending: [],
    };
    summarize.mockImplementation(async () => {
      expect((await service.inspect({ conversationId: "conversation" })).summary).toBeNull();
      return longSummary;
    });
    const result = await service.prepare({ conversationId: "conversation" });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1]?.[0].previous).toEqual(longSummary);
    expect(summarize.mock.calls[1]?.[0].text).toContain("第 6 条");
    expect(summarize.mock.calls[1]?.[0].text).not.toContain("第 0 条");
    expect(result.status.retainedMessages).toBe(4);
    expect(result.status.estimatedInputTokens).toBeLessThanOrEqual(result.status.inputBudgetTokens);
    expect(await store.listMessages("conversation")).toHaveLength(12);
  });
  it("压缩至最后完整问答仍无法容纳时保留旧摘要，后续未回复输入也不被压缩", async () => {
    const { service, add, store, summarize } = setup();
    for (let i = 0; i < 10; i++) add(i);
    const first = await service.compact({ conversationId: "conversation" });
    add(10, "最终问题".repeat(700));
    add(11, "最终回答".repeat(700));
    add(12, "尚未回复的新请求");
    summarize.mockClear();
    await expect(service.prepare({ conversationId: "conversation" })).rejects.toThrow(
      /压缩后仍超过/,
    );
    expect(summarize).toHaveBeenCalled();
    for (const [input] of summarize.mock.calls) {
      expect(input.text).not.toContain("最终问题");
      expect(input.text).not.toContain("最终回答");
      expect(input.text).not.toContain("尚未回复的新请求");
    }
    expect((await service.inspect({ conversationId: "conversation" })).summary).toEqual(
      first.summary,
    );
    expect((await service.inspect({ conversationId: "conversation" })).updatedAt).toBe(
      first.updatedAt,
    );
    expect(await store.listMessages("conversation")).toHaveLength(13);
  });
  it("默认主模型窗口不足时允许备用模型，显式选择仍只用指定模型", async () => {
    const { service, add, summarize, resolver } = setup();
    add(0, "保留之前的目标");
    faux = registerFauxProvider({
      tokensPerSecond: 100000,
      models: [
        { id: "small", contextWindow: 8192, maxTokens: 1024 },
        { id: "large", contextWindow: 128000, maxTokens: 4096 },
      ],
    });
    const candidates = faux.models.map((model) => ({
      providerId: model.id,
      providerName: model.id,
      model,
      apiKey: "test",
    }));
    resolver.resolve = async (_agent, selection) =>
      selection
        ? candidates.filter((candidate) => candidate.model.id === selection.model)
        : candidates;
    const userMessage = "新资料".repeat(3500);
    const result = await service.prepare({ conversationId: "conversation", userMessage });
    expect(result.compacted).toBe(false);
    expect(result.status.model).toBe("large");
    expect(result.history).toHaveLength(1);
    expect(summarize).not.toHaveBeenCalled();
    let usedModel = "";
    faux.setResponses([
      (_context, _options, _state, model) => {
        usedModel = model.id;
        return fauxAssistantMessage("备用模型完成");
      },
    ]);
    await runAgent({
      definition: {
        name: "code",
        title: "code",
        description: "code",
        systemPrompt: "继续工作",
        tools: [],
      },
      models: candidates,
      tools: [],
      messages: [...result.history, { role: "user", content: userMessage, timestamp: 0 }],
      emit: () => {},
      requestApproval: async () => true,
    });
    expect(usedModel).toBe("large");
    expect(faux.state.callCount).toBe(1);
    await expect(
      service.prepare({
        conversationId: "conversation",
        userMessage,
        modelSelection: { providerId: "small", model: "small" },
      }),
    ).rejects.toThrow(/超出模型预算/);
  });
  it("长历史先整体脱敏，分块保留完整占位符且不丢失原文", async () => {
    const maskFactory = vi.fn(createMaskStore);
    const { service, add, store, summarize } = setup({ maskFactory });
    for (let i = 0; i < 12; i++) add(i, i < 6 ? "contact@example.com ".repeat(1000) : "近期消息");
    const result = await service.compact({ conversationId: "conversation" });
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    let restored = "";
    for (const [input] of summarize.mock.calls) {
      expect(input.text).not.toContain("contact@example.com");
      expect(input.text.replace(/\{\{MASK_EMAIL_\d+\}\}/g, "")).not.toContain("MASK_");
      restored += unmaskText(input.text, input.mask!);
    }
    const original = (await store.listMessages("conversation"))
      .slice(0, result.summarizedMessages)
      .map((message) =>
        JSON.stringify({ role: message.role, text: message.content, tools: message.toolCalls }),
      )
      .join("\n");
    expect(restored).toBe(original);
    expect(maskFactory).toHaveBeenCalledOnce();
  });
  it("摘要调用遵循脱敏设置，恢复本地摘要并报告真实用量", async () => {
    const { add, resolver } = setup();
    for (let i = 0; i < 10; i++) add(i, `请联系 contact@example.com，记录 ${i}`);
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    resolver.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux!.getModel(), apiKey: "test" },
    ];
    let outbound = "";
    faux.setResponses([
      (context) => {
        outbound = JSON.stringify(context);
        const masked = outbound.match(/\{\{MASK_EMAIL_\d+\}\}/)?.[0];
        return fauxAssistantMessage(
          JSON.stringify({
            goal: `请联系 ${masked}`,
            constraints: [],
            decisions: [],
            facts: [],
            pending: [],
          }),
        );
      },
    ]);
    const maskFactory = vi.fn(createMaskStore);
    const service = new ConversationContextService(database!.db, resolver, { maskFactory });
    const events: AgentStreamEvent[] = [];
    const result = await service.compact({
      conversationId: "conversation",
      emit: (event) => events.push(event),
    });
    expect(outbound).not.toContain("contact@example.com");
    expect(outbound).toContain("{{MASK_EMAIL_");
    expect(result.summary?.goal).toBe("请联系 contact@example.com");
    expect(maskFactory).toHaveBeenCalledOnce();
    const usage = events.find((event) => event.type === "model_usage");
    expect(usage).toMatchObject({ purpose: "compaction", providerId: "faux" });
    expect(usage?.totalTokens).toBeGreaterThan(0);
  });
  it("预算充足时回放超过20条消息，原始目标不会静默丢弃", async () => {
    const { service, add, summarize } = setup();
    for (let i = 0; i < 30; i++) add(i);
    const result = await service.prepare({ conversationId: "conversation", userMessage: "继续" });
    expect(result.history).toHaveLength(30);
    expect(result.history[0]?.content).toContain("第 0 条消息");
    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({
      estimated: true,
      capacitySource: "configured",
      contextWindow: 8192,
    });
  });
  it("自动压缩保存目标约束及边界，保留所有原文和最近消息", async () => {
    const { service, add, store, summarize } = setup();
    for (let i = 0; i < 30; i++)
      add(i, i === 0 ? "开发项目，保留原有数据" : "会话资料".repeat(150));
    const result = await service.prepare({ conversationId: "conversation", userMessage: "继续" });
    expect(result.compacted).toBe(true);
    expect(result.status.summary?.constraints).toContain("保留原有数据");
    expect(result.status.summarizedMessages).toBeGreaterThan(0);
    expect(result.status.estimatedInputTokens).toBeLessThanOrEqual(result.status.inputBudgetTokens);
    expect(result.history.at(-1)?.content).toEqual(
      store.toPiMessages(await store.listMessages("conversation")).at(-1)?.content,
    );
    expect(await store.listMessages("conversation")).toHaveLength(30);
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of summarize.mock.calls)
      expect(estimateTokens(input.text)).toBeLessThanOrEqual(6000);
    const restarted = new ConversationContextService(database!.db, { resolve: async () => [] });
    expect((await restarted.inspect({ conversationId: "conversation" })).summary?.goal).toBe(
      "开发项目",
    );
  });
  it("手动压缩只摘要新增的历史前缀，并合并已有摘要", async () => {
    const { service, add, summarize } = setup();
    for (let i = 0; i < 10; i++) add(i);
    const first = await service.compact({ conversationId: "conversation" });
    expect(first.summarizedMessages).toBe(4);
    for (let i = 10; i < 14; i++) add(i);
    await service.compact({ conversationId: "conversation" });
    expect(summarize.mock.calls[1]?.[0].previous?.goal).toBe("开发项目");
    expect(summarize.mock.calls[1]?.[0].text).not.toContain("第 0 条消息");
    expect(summarize.mock.calls[1]?.[0].text).toContain("第 4 条消息");
  });
  it("摘要失败和取消保留此前有效摘要与原文", async () => {
    const { service, add, summarize, store } = setup();
    for (let i = 0; i < 10; i++) add(i);
    const first = await service.compact({ conversationId: "conversation" });
    for (let i = 10; i < 14; i++) add(i);
    summarize.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(service.compact({ conversationId: "conversation" })).rejects.toThrow(
      "temporary failure",
    );
    expect((await service.inspect({ conversationId: "conversation" })).updatedAt).toBe(
      first.updatedAt,
    );
    const controller = new AbortController();
    summarize.mockImplementationOnce(async ({ previous }) => {
      controller.abort();
      return previous!;
    });
    await expect(
      service.compact({ conversationId: "conversation", signal: controller.signal }),
    ).rejects.toThrow();
    expect((await service.inspect({ conversationId: "conversation" })).updatedAt).toBe(
      first.updatedAt,
    );
    expect(await store.listMessages("conversation")).toHaveLength(14);
  });
  it("压缩期间历史变化或并发压缩不会发布陈旧摘要", async () => {
    const { service, add, summarize } = setup();
    for (let i = 0; i < 10; i++) add(i);
    summarize.mockImplementationOnce(async () => {
      await expect(service.prepare({ conversationId: "conversation" })).rejects.toThrow(/正在压缩/);
      add(10);
      return { goal: "陈旧结果", constraints: [], decisions: [], facts: [], pending: [] };
    });
    await expect(service.compact({ conversationId: "conversation" })).rejects.toThrow(/发生变化/);
    expect((await service.inspect({ conversationId: "conversation" })).summary).toBeNull();
    expect(service.isCompacting("conversation")).toBe(false);
  });
  it("传入已存储当前消息之前的历史不会重复本轮输入", async () => {
    const { service, store, add } = setup();
    for (let i = 0; i < 10; i++) add(i);
    const history = await store.listMessages("conversation");
    add(10, "当前请求");
    const result = await service.prepare({
      conversationId: "conversation",
      history,
      userMessage: "当前请求",
    });
    expect(result.history).toHaveLength(10);
    expect(JSON.stringify(result.history)).not.toContain("当前请求");
  });
  it("无法压缩的超长当前输入明确失败而不丢弃消息", async () => {
    const { service, add, store, summarize } = setup();
    add(0, "目标不能丢失");
    await expect(
      service.prepare({ conversationId: "conversation", userMessage: "资料".repeat(10000) }),
    ).rejects.toThrow(/超出模型预算/);
    expect(summarize).not.toHaveBeenCalled();
    expect(await store.listMessages("conversation")).toHaveLength(1);
  });
});

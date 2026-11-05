import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import type { AgentStreamEvent } from "@agentdesk/shared";
import { afterEach, expect, it, vi } from "vitest";
import { runAgent, defineTool, Type, toWireName } from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => {
  faux?.unregister();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const events: AgentStreamEvent[] = [];
  const options = {
    definition: {
      name: "orchestrator" as const,
      title: "测试",
      description: "测试",
      systemPrompt: "完成任务",
      tools: [],
    },
    tools: [],
    models: [{ providerId: "test", providerName: "test", apiKey: "test", model: faux.getModel() }],
    messages: [],
    emit: (event: AgentStreamEvent) => events.push(event),
    requestApproval: async () => false,
  };
  return { events, options };
}

it("无响应会说明状态并自动重试，旧请求迟到的回复不会混入新回答", async () => {
  const { events, options } = setup();
  let finishFirst!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
  faux!.setResponses([
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    fauxAssistantMessage(fauxText("已恢复，继续制作。")),
  ]);
  const pending = runAgent(options);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "response_status", message: "响应较慢，仍在等待回复…" }),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await pending).text).toBe("已恢复，继续制作。");
  expect(events).toContainEqual(
    expect.objectContaining({ type: "response_status", message: "响应中断，正在自动重试…" }),
  );
  finishFirst(fauxAssistantMessage(fauxText("迟到的旧回复")));
  await vi.advanceTimersByTimeAsync(1000);
  expect(events.some((event) => event.type === "text_delta" && event.delta.includes("迟到"))).toBe(
    false,
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("所有尝试共用 90 秒预算，即使供应商忽略取消也会结束等待", async () => {
  const { events, options } = setup();
  const never = () => new Promise<ReturnType<typeof fauxAssistantMessage>>(() => {});
  faux!.setResponses([never, never, never]);
  const pending = expect(runAgent(options)).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(90_000);
  await pending;
  expect(faux!.state.callCount).toBe(3);
  expect(events.filter((event) => event.type === "response_status")).not.toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("工具参数流中断时可重试，工具只在完整成功的响应后执行一次", async () => {
  const { options } = setup();
  let writes = 0;
  const tool = defineTool({
    name: "documents.append",
    description: "写入章节",
    parameters: Type.Object({}),
    risk: "safe",
    execute: async () => ++writes,
  });
  faux!.setResponses([
    fauxAssistantMessage(fauxToolCall(toWireName(tool.name), {}), {
      stopReason: "error",
      errorMessage: "Request timed out.",
    }),
    fauxAssistantMessage(fauxToolCall(toWireName(tool.name), {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("文档已完成。")),
  ]);
  const pending = runAgent({ ...options, tools: [tool] });
  await vi.advanceTimersByTimeAsync(3000);
  expect((await pending).text).toBe("文档已完成。");
  expect(writes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("已公开正文后发生错误不会拼接另一轮回复，显式停止会立即结束", async () => {
  const { options } = setup();
  faux!.setResponses([
    fauxAssistantMessage(fauxText("已经开始回答"), {
      stopReason: "error",
      errorMessage: "Request timed out.",
    }),
  ]);
  const partial = expect(runAgent(options)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(1000);
  await partial;
  expect(faux!.state.callCount).toBe(1);
  faux!.setResponses([() => new Promise(() => {})]);
  const controller = new AbortController();
  const stopped = expect(runAgent({ ...options, signal: controller.signal })).rejects.toThrow(
    "取消",
  );
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

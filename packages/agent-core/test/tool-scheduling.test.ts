import { setImmediate } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Type, defineTool, runAgent, toWireName, type AnyAgentTool } from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => faux?.unregister());

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function start(tools: AnyAgentTool[], options: Partial<Parameters<typeof runAgent>[0]> = {}) {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([
    fauxAssistantMessage(
      tools.map((tool) => fauxToolCall(toWireName(tool.name), {})),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxText("完成")),
  ]);
  return runAgent({
    definition: {
      name: "code",
      title: "编码",
      description: "编码",
      systemPrompt: "编码",
      tools: [],
    },
    tools,
    models: [{ providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" }],
    messages: [{ role: "user", content: "修改并验证", timestamp: Date.now() }],
    emit: () => {},
    requestApproval: async () => true,
    ...options,
  });
}

describe("工具执行顺序", () => {
  it("只读工具重叠执行，写操作等待前序读取，后续读取看到写入结果，记录保持调用顺序", async () => {
    const first = gate();
    const second = gate();
    const bothStarted = gate();
    const writeStarted = gate();
    const write = gate();
    const events: string[] = [];
    let value = "before";
    let readsStarted = 0;
    const reads = [first, second].map((pending, index) =>
      defineTool({
        name: `read${index}`,
        description: "读取",
        parameters: Type.Object({}),
        risk: "safe",
        isConcurrencySafe: true,
        execute: async () => {
          events.push(`read${index}:start`);
          if (++readsStarted === 2) bothStarted.release();
          await pending.promise;
          events.push(`read${index}:end`);
          return value;
        },
      }),
    );
    const running = start([
      ...reads,
      defineTool({
        name: "write",
        description: "写入",
        parameters: Type.Object({}),
        risk: "safe",
        execute: async () => {
          events.push("write:start");
          writeStarted.release();
          await write.promise;
          value = "after";
          return value;
        },
      }),
      defineTool({
        name: "verify",
        description: "验证",
        parameters: Type.Object({}),
        risk: "safe",
        isConcurrencySafe: true,
        execute: async () => {
          events.push("verify");
          return value;
        },
      }),
    ]);
    try {
      await bothStarted.promise;
      second.release();
      await setImmediate();
      expect(events).not.toContain("write:start");
      first.release();
      await writeStarted.promise;
      expect(events).not.toContain("verify");
      write.release();
      const result = await running;
      expect(result.toolCalls.map((call) => call.name)).toEqual([
        "read0",
        "read1",
        "write",
        "verify",
      ]);
      expect(result.toolCalls.map((call) => call.result)).toEqual([
        "before",
        "before",
        "after",
        "after",
      ]);
      expect(events.indexOf("read1:end")).toBeLessThan(events.indexOf("read0:end"));
    } finally {
      first.release();
      second.release();
      write.release();
      await running.catch(() => {});
    }
  });

  it("取消后等待已启动的读取收尾，不弹出后续审批或启动写入", async () => {
    const controller = new AbortController();
    const first = gate();
    const second = gate();
    const bothStarted = gate();
    let count = 0;
    let mutations = 0;
    let approvals = 0;
    let settled = false;
    const tools = [first, second].map((pending, index) =>
      defineTool({
        name: `read${index}`,
        description: "读取",
        parameters: Type.Object({}),
        risk: "safe",
        isConcurrencySafe: true,
        execute: async () => {
          if (++count === 2) bothStarted.release();
          await pending.promise;
          return "read";
        },
      }),
    );
    const running = start(
      [
        ...tools,
        defineTool({
          name: "write",
          description: "写入",
          parameters: Type.Object({}),
          risk: "confirm",
          execute: async () => {
            mutations++;
          },
        }),
      ],
      {
        signal: controller.signal,
        requestApproval: async () => {
          approvals++;
          return true;
        },
      },
    );
    const outcome = running.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await bothStarted.promise;
      controller.abort(new Error("已取消"));
      first.release();
      await setImmediate();
      expect(settled).toBe(false);
      second.release();
      expect(await outcome).toMatchObject({ message: "已取消" });
      expect(mutations).toBe(0);
      expect(approvals).toBe(0);
    } finally {
      first.release();
      second.release();
      await outcome;
    }
  });

  it("事件回调失败仍等待并发工具，不提前返回并遗留后台操作", async () => {
    const slow = gate();
    const slowStarted = gate();
    const failed = gate();
    let settled = false;
    let mutated = false;
    const running = start(
      [
        defineTool({
          name: "first",
          description: "读取",
          parameters: Type.Object({}),
          risk: "safe",
          isConcurrencySafe: true,
          execute: async () => {
            await slowStarted.promise;
            return "first";
          },
        }),
        defineTool({
          name: "second",
          description: "读取",
          parameters: Type.Object({}),
          risk: "safe",
          isConcurrencySafe: true,
          execute: async () => {
            slowStarted.release();
            await slow.promise;
            return "second";
          },
        }),
        defineTool({
          name: "write",
          description: "写入",
          parameters: Type.Object({}),
          risk: "safe",
          execute: async () => {
            mutated = true;
          },
        }),
      ],
      {
        emit: (event) => {
          if (event.type === "tool_result" && event.result === "first") {
            failed.release();
            throw new Error("事件存储失败");
          }
        },
      },
    );
    const outcome = running.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await failed.promise;
      await setImmediate();
      expect(settled).toBe(false);
      slow.release();
      expect(await outcome).toMatchObject({ message: "事件存储失败" });
      expect(mutated).toBe(false);
    } finally {
      slow.release();
      await outcome;
    }
  });
});

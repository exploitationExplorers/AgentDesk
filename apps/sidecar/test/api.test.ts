import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let app: Hono;
let faux: FauxProviderRegistration;
const TOKEN = "test-token";

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-AgentDesk-Token": TOKEN,
      ...(init.headers ?? {}),
    },
  });

const json = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
  const res = await call(path, init);
  return (await res.json()) as T;
};

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-test-"));
  const config = { ...loadConfig({ AGENTDESK_DATA_DIR: dataDir }), token: TOKEN };
  container = await createContainer(config, { inMemory: true });
  app = createApp(container);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
});

afterAll(async () => {
  faux.unregister();
  await container.dispose();
});

describe("auth", () => {
  it("缺少令牌时拒绝访问", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(401);
  });
});

describe("providers", () => {
  it("创建 Provider 后密钥不回传，hasKey 为 true", async () => {
    const created = await json<{ id: string; hasKey: boolean; apiKey?: string }>("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Relay",
        api: "openai-completions",
        baseUrl: "https://relay.example.com/v1",
        models: ["gpt-4o-mini"],
        defaultModel: "gpt-4o-mini",
        source: "manual",
        enabled: true,
        apiKey: "sk-secret-value",
      }),
    });
    expect(created.hasKey).toBe(true);
    expect(created.apiKey).toBeUndefined();
    expect(container.secrets.get(`provider:${created.id}`)).toBe("sk-secret-value");
    const resolved = await container.providers.resolve("research");
    expect(resolved[0]?.model.baseUrl).toBe("https://relay.example.com/v1");
  });

  it("参数错误返回 400", async () => {
    const res = await call("/providers", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(res.status).toBe(400);
  });
});

describe("workflows", () => {
  it("从模板创建并运行空白工作流", async () => {
    const wf = await json<{ id: string }>("/workflows/from-template", {
      method: "POST",
      body: JSON.stringify({ key: "blank" }),
    });
    const run = await json<{ id: string }>(`/workflows/${wf.id}/run`, {
      method: "POST",
      body: "{}",
    });
    const final = await container.workflows.wait(run.id);
    expect(final.status).toBe("succeeded");
  });

  it("审批节点被拒绝时工作流失败", async () => {
    const wf = await json<{ id: string }>("/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "need approval",
        nodes: [
          { id: "s", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
          {
            id: "a",
            type: "approval",
            position: { x: 0, y: 0 },
            data: { label: "审批", config: { title: "确认" } },
          },
        ],
        edges: [{ id: "e", source: "s", target: "a" }],
      }),
    });
    const run = await json<{ id: string }>(`/workflows/${wf.id}/run`, {
      method: "POST",
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 50));
    const [pending] = await json<Array<{ id: string }>>("/approvals?status=pending");
    await call(`/approvals/${pending!.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: false }),
    });
    const final = await container.workflows.wait(run.id);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("审批被拒绝");
  });
});

describe("chat", () => {
  it("SSE 流式返回 Agent 事件并持久化消息", async () => {
    // 让 resolver 使用 faux 模型
    const original = container.providers.resolve.bind(container.providers);
    container.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
    ];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("projects.list"), {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("你还没有添加项目。")),
      fauxAssistantMessage(fauxText('{"memories":[]}')),
    ]);
    const res = await call("/chat", {
      method: "POST",
      body: JSON.stringify({ message: "我有哪些项目", agent: "project" }),
    });
    const body = await res.text();
    container.providers.resolve = original;

    const events = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)));
    expect(events[0].type).toBe("conversation");
    expect(events.some((e) => e.type === "tool_call" && e.name === "projects.list")).toBe(true);
    expect(events.at(-1).type).toBe("done");

    const messages = await json<Array<{ role: string; content: string }>>(
      `/conversations/${events[0].conversationId}/messages`,
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content).toBe("你还没有添加项目。");
  });

  it("抽取失败不影响本轮对话", async () => {
    const originalResolve = container.providers.resolve.bind(container.providers);
    container.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
    ];
    const originalCapture = container.memory.captureFromTurn.bind(container.memory);
    container.memory.captureFromTurn = async () => {
      throw new Error("抽取失败");
    };
    faux.setResponses([fauxAssistantMessage(fauxText("好的"))]);
    try {
      const res = await call("/chat", {
        method: "POST",
        body: JSON.stringify({ message: "你好" }),
      });
      const body = await res.text();
      const events = body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)) as { type: string; conversationId?: string });
      expect(events.at(-1)?.type).toBe("done");
      const messages = await json<Array<{ role: string; content: string }>>(
        `/conversations/${events[0]?.conversationId}/messages`,
      );
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.content).toBe("好的");
    } finally {
      container.providers.resolve = originalResolve;
      container.memory.captureFromTurn = originalCapture;
    }
  });
});

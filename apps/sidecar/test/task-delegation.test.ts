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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-task-delegation-"));
  const config = { ...loadConfig({ AGENTDESK_DATA_DIR: dataDir }), token: TOKEN };
  container = await createContainer(config, { inMemory: true });
  app = createApp(container);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  // 全程让真实 orchestrator 用 faux 模型，不消耗真实模型额度。
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
  ];
});

afterAll(async () => {
  faux.unregister();
  await container.dispose();
});

describe("Task 真实执行（队列真正领取并调用 orchestrator）", () => {
  it("简单任务：队列领取、真正执行，落地 awaiting_review 与真实事件序列", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("你好，我是 AgentDesk。"))]);

    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "打个招呼" }),
    });

    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");

    const finalTask = container.tasks.get(task.id)!;
    expect(finalTask.status).toBe("awaiting_review");

    const [run] = container.tasks.listRuns(task.id);
    expect(run!.status).toBe("succeeded");
    expect(run!.resultText).toBe("你好，我是 AgentDesk。");

    const events = await json<Array<{ event: { type: string } }>>(`/runs/${run!.id}/events`);
    const types = events.map((e) => e.event.type);
    expect(types[0]).toBe("run_started");
    expect(types).toContain("agent_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("agent_end");
    expect(types.at(-1)).toBe("run_ended");
  });

  it("并发委派：产生两条独立子 Run，事件各自归属、不会串台", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(toWireName("agents.delegate"), { agent: "project", task: "调研项目A" }),
          fauxToolCall(toWireName("agents.delegate"), { agent: "research", task: "调研项目B" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("项目A的结论")),
      fauxAssistantMessage(fauxText("项目B的结论")),
      fauxAssistantMessage(fauxText("汇总：A 和 B 都已完成")),
    ]);

    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "并行调研两个项目" }),
    });

    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");

    const runs = container.tasks.listRuns(task.id);
    const rootRun = runs.find((r) => r.kind === "root")!;
    const childRuns = runs.filter((r) => r.kind === "delegate");

    expect(rootRun.resultText).toBe("汇总：A 和 B 都已完成");
    expect(childRuns.length).toBe(2);
    expect(childRuns.every((r) => r.parentRunId === rootRun.id)).toBe(true);
    expect(childRuns.every((r) => r.status === "succeeded")).toBe(true);
    expect(childRuns.map((r) => r.agent).sort()).toEqual(["project", "research"]);

    const [childA, childB] = childRuns;
    const eventsA = await json<
      Array<{ runId: string; parentRunId: string | null; event: { type: string } }>
    >(`/runs/${childA!.id}/events`);
    const eventsB = await json<
      Array<{ runId: string; parentRunId: string | null; event: { type: string } }>
    >(`/runs/${childB!.id}/events`);

    // 各自只包含归属自己这次委派的事件，不会出现对方的 runId。
    expect(eventsA.every((e) => e.runId === childA!.id)).toBe(true);
    expect(eventsB.every((e) => e.runId === childB!.id)).toBe(true);
    expect(eventsA.every((e) => e.parentRunId === rootRun.id)).toBe(true);
    expect(eventsB.every((e) => e.parentRunId === rootRun.id)).toBe(true);
    expect(eventsA.map((e) => e.event.type)[0]).toBe("run_started");
    expect(eventsA.map((e) => e.event.type).at(-1)).toBe("run_ended");
    expect(eventsB.map((e) => e.event.type)[0]).toBe("run_started");
    expect(eventsB.map((e) => e.event.type).at(-1)).toBe("run_ended");
  });
});

describe("/chat 借壳产生 Task", () => {
  it("一轮 /chat 自动借壳产生 Task；同一会话第二轮复用同一个 Task 的第二条 Run", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxText("收到")),
      fauxAssistantMessage(fauxText('{"memories":[]}')),
    ]);
    const res1 = await call("/chat", {
      method: "POST",
      body: JSON.stringify({ message: "你好" }),
    });
    const events1 = (await res1.text())
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as { type: string; conversationId?: string });
    const conversationId = events1[0]!.conversationId!;

    await waitFor(() => container.tasks.findByConversation(conversationId) !== undefined);
    const task = container.tasks.findByConversation(conversationId)!;
    expect(task.conversationId).toBe(conversationId);
    expect(container.tasks.listRuns(task.id).length).toBe(1);

    faux.setResponses([
      fauxAssistantMessage(fauxText("再次收到")),
      fauxAssistantMessage(fauxText('{"memories":[]}')),
    ]);
    const res2 = await call("/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, message: "还在吗" }),
    });
    await res2.text(); // 必须把 SSE 响应体读完，否则 send() 的后台处理还没真正结束

    const sameTask = container.tasks.findByConversation(conversationId)!;
    expect(sameTask.id).toBe(task.id);
    const runsAfterSecond = container.tasks.listRuns(task.id);
    expect(runsAfterSecond.length).toBe(2);
    expect(runsAfterSecond.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("shadow task 创建失败时不影响 /chat 本身的响应", async () => {
    const original = container.tasks.findByConversation.bind(container.tasks);
    container.tasks.findByConversation = () => {
      throw new Error("模拟 shadow task 故障");
    };
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxText("没问题")),
        fauxAssistantMessage(fauxText('{"memories":[]}')),
      ]);
      const res = await call("/chat", {
        method: "POST",
        body: JSON.stringify({ message: "测试降级" }),
      });
      const events = (await res.text())
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map(
          (l) =>
            JSON.parse(l.slice(5)) as { type: string; conversationId?: string; messageId?: string },
        );
      expect(events.at(-1)?.type).toBe("done");
      const messages = await json<Array<{ role: string; content: string }>>(
        `/conversations/${events[0]!.conversationId}/messages`,
      );
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1]!.content).toBe("没问题");
    } finally {
      container.tasks.findByConversation = original;
    }
  });
});

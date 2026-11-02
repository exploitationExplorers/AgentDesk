import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxText,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import type { ContextSummary, SessionWorkbench } from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { createApp } from "../src/http/app";
import { ConversationContextService } from "../src/services/conversation-context";
import { ConversationStore } from "../src/services/conversation-store";

let container: Container;
let faux: FauxProviderRegistration;
beforeAll(async () => {
  container = await createContainer(
    {
      ...loadConfig({ AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-session-")) }),
      token: "test",
    },
    { inMemory: true },
  );
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
  ];
});
afterAll(async () => {
  await container.dispose();
  faux.unregister();
});
const request = (path: string, method = "GET", body?: unknown) =>
  createApp(container).request(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

it("聊天完成后状态栏返回真实运行、模型用量和预算", async () => {
  faux.setResponses([
    fauxAssistantMessage(fauxText("已收到")),
    fauxAssistantMessage(fauxText('{"memories":[]}')),
  ]);
  const result = await request("/chat", "POST", { message: "你好", agent: "code" });
  const text = await result.text();
  expect(text).toContain("model_usage");
  const conversation = container.chat.listConversations()[0]!;
  const state = (await (
    await request(`/conversations/${conversation.id}/workbench`)
  ).json()) as SessionWorkbench;
  expect(state.activity).toBeNull();
  expect(state.task?.status).toBe("awaiting_review");
  expect(state.runs[0]?.status).toBe("succeeded");
  expect(state.latestUsage?.providerId).toBe("faux");
  expect(state.context).toMatchObject({ estimated: true, messageCount: 2 });
});

it("压缩和排队期间拒绝删除，发布摘要后继续保留全部历史", async () => {
  const conversation = container.chat.conversations.put({
    id: "long-session",
    title: "长会话",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const store = new ConversationStore(container.dbHandle.db);
  for (let i = 0; i < 12; i++)
    store.insertMessage({
      id: `long-${i}`,
      conversationId: conversation.id,
      role: i % 2 ? "assistant" : "user",
      content: `消息 ${i}`,
      agent: null,
      toolCalls: [],
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    });
  let finish: ((summary: ContextSummary) => void) | undefined;
  const context = new ConversationContextService(container.dbHandle.db, container.providers, {
    summarize: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  container.context = context;
  container.chat.setContextService(context);
  const compacting = request(`/conversations/${conversation.id}/compact`, "POST", {});
  await vi.waitFor(() => expect(finish).toBeDefined());
  const state = (await (
    await request(`/conversations/${conversation.id}/workbench`)
  ).json()) as SessionWorkbench;
  expect(state.activity).toBe("compacting");
  expect((await request(`/conversations/${conversation.id}`, "DELETE")).status).toBe(409);
  const chat = await request("/chat", "POST", {
    conversationId: conversation.id,
    message: "不要并发追加",
  });
  expect(await chat.text()).toContain("会话正在执行或压缩");
  finish!({
    goal: "保留目标",
    constraints: ["不能删除源记录"],
    decisions: [],
    facts: [],
    pending: ["继续验证"],
  });
  expect((await compacting).status).toBe(200);
  const after = (await (
    await request(`/conversations/${conversation.id}/workbench`)
  ).json()) as SessionWorkbench;
  expect(after.context?.summary?.goal).toBe("保留目标");
  expect(after.context?.summarizedMessages).toBe(6);
  expect(after.lastCompaction?.phase).toBe("complete");
  expect(container.chat.messages(conversation.id)).toHaveLength(12);
  // 排队中的 Run 尚未取得会话锁，也必须阻止删除其历史和摘要。
  const task = container.tasks.create({
    goal: "等待继续长会话",
    conversationId: conversation.id,
    requiresPlanApproval: false,
  });
  const run = container.tasks.createRun({
    taskId: task.id,
    kind: "root",
    agent: "code",
    trigger: "create",
    input: { userMessage: "继续验证" },
  });
  const queuedTask = container.tasks.get(task.id);
  expect((await request(`/conversations/${conversation.id}`, "DELETE")).status).toBe(409);
  expect(container.chat.getConversation(conversation.id)).toEqual(conversation);
  expect(container.chat.messages(conversation.id)).toHaveLength(12);
  expect((await context.inspect({ conversationId: conversation.id })).summary).toEqual(
    after.context?.summary,
  );
  expect(container.tasks.get(task.id)).toEqual(queuedTask);
  expect(container.tasks.getRun(run.id)?.status).toBe("queued");
  container.tasks.cancelTask(task.id);
  container.tasks.enqueue(run.id);
  expect(container.tasks.getRun(run.id)?.status).toBe("cancelled");
  expect((await request(`/conversations/${conversation.id}`, "DELETE")).status).toBe(204);
  expect((await context.inspect({ conversationId: conversation.id })).summary).toBeNull();
});

it("模型配置不可用时仍能读取任务状态，未知会话返回404", async () => {
  const resolve = container.providers.resolve;
  container.providers.resolve = async () => {
    throw new Error("模型配置不可用");
  };
  try {
    const conversation = container.chat.listConversations()[0]!;
    const response = await request(`/conversations/${conversation.id}/workbench`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: null, contextError: "模型配置不可用" });
    expect((await request("/conversations/absent/workbench")).status).toBe(404);
  } finally {
    container.providers.resolve = resolve;
  }
});

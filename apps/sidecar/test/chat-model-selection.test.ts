import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, ModelSelection, Provider } from "@agentdesk/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let provider: Provider;
let other: Provider;
let app: ReturnType<typeof createApp>;
const call = (path: string, body?: unknown, method = "POST") =>
  app.request(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "selection-test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const config = {
    ...loadConfig({ AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-model-test-")) }),
    token: "selection-test",
  };
  container = await createContainer(config, { inMemory: true });
  app = createApp(container);
  provider = container.providers.create({
    name: "First",
    api: "openai-completions",
    baseUrl: "https://first.invalid/v1",
    models: ["default", "selected"],
    defaultModel: "default",
    source: "manual",
    enabled: true,
    apiKey: "first-test-key",
  });
  other = container.providers.create({
    name: "Second",
    api: "anthropic-messages",
    baseUrl: "https://second.invalid",
    models: ["other"],
    defaultModel: "other",
    source: "manual",
    enabled: true,
    apiKey: "second-test-key",
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => container.dispose());

describe("会话模型选择", () => {
  it("选择精确 Provider 和模型，不改变全局绑定或其他请求的默认解析", async () => {
    const binding = [
      {
        agent: "orchestrator",
        providerId: provider.id,
        model: "default",
        fallbackProviderIds: [other.id],
      },
    ];
    container.providers.setBindings(binding);
    const [selected, defaults] = await Promise.all([
      container.providers.resolve("code", { providerId: other.id, model: "Custom-Case-Sensitive" }),
      container.providers.resolve("code"),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      providerId: other.id,
      apiKey: "second-test-key",
      model: {
        id: "Custom-Case-Sensitive",
        api: "anthropic-messages",
        baseUrl: "https://second.invalid",
      },
    });
    expect(defaults[0]).toMatchObject({ providerId: provider.id, model: { id: "default" } });
    expect(container.providers.listBindings()).toEqual(binding);
  });

  it("两个并发 /chat 请求分别传递模型，普通请求继续使用默认值", async () => {
    const seen: { message: string; selection: ModelSelection | undefined }[] = [];
    vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
    vi.spyOn(container.orchestrator, "run").mockImplementation(async (options) => {
      seen.push({ message: options.userMessage, selection: options.modelSelection });
      const models = await container.providers.resolve(
        options.agent ?? "orchestrator",
        options.modelSelection,
      );
      return { text: models[0]!.model.id, agent: options.agent ?? "orchestrator", toolCalls: [] };
    });
    const a = { providerId: provider.id, model: "selected" };
    const b = { providerId: other.id, model: "other" };
    const responses = await Promise.all([
      call("/chat", { message: "A", modelSelection: a }),
      call("/chat", { message: "B", agent: "code", modelSelection: b }),
      call("/chat", { message: "default" }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"done"');
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        { message: "A", selection: a },
        { message: "B", selection: b },
        { message: "default", selection: undefined },
      ]),
    );
    const conversations = (await (
      await call("/conversations", undefined, "GET")
    ).json()) as Conversation[];
    for (const [title, text] of [
      ["A", "selected"],
      ["B", "other"],
      ["default", "default"],
    ]) {
      const conversation = conversations.find((item) => item.title === title)!;
      expect(container.chat.messages(conversation.id).at(-1)?.content).toBe(text);
    }
  });

  it("停用、无密钥或不存在的 Provider 在 SSE 开始前被拒绝且不创建会话", async () => {
    const noKey = container.providers.create({
      name: "No key",
      api: "openai-completions",
      baseUrl: "https://none.invalid/v1",
      models: ["x"],
      defaultModel: "x",
      source: "manual",
      enabled: true,
    });
    const disabled = container.providers.create({
      name: "Disabled",
      api: "openai-completions",
      baseUrl: "https://disabled.invalid/v1",
      models: ["x"],
      defaultModel: "x",
      source: "manual",
      enabled: false,
      apiKey: "unused",
    });
    const before = container.chat.listConversations().length;
    for (const id of [noKey.id, disabled.id, "missing"]) {
      const response = await call("/chat", {
        message: "should-not-run",
        modelSelection: { providerId: id, model: "x" },
      });
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    const malformed = await call("/chat", {
      message: "invalid",
      modelSelection: { providerId: provider.id, model: " " },
    });
    expect(malformed.status).toBe(400);
    expect(container.chat.listConversations()).toHaveLength(before);
  });

  it("重命名会话持久化标题，拒绝空标题和未知会话", async () => {
    vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
    vi.spyOn(container.orchestrator, "run").mockResolvedValue({
      text: "ok",
      agent: "orchestrator",
      toolCalls: [],
    });
    const conversationId = await container.chat.send(
      { message: "原始标题" },
      () => {},
      new AbortController().signal,
    );
    const response = await call(
      `/conversations/${conversationId}`,
      { title: "  新标题  " },
      "PATCH",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: conversationId, title: "新标题" });
    expect(
      container.chat.listConversations().find((item) => item.id === conversationId)?.title,
    ).toBe("新标题");
    expect((await call(`/conversations/${conversationId}`, { title: " " }, "PATCH")).status).toBe(
      400,
    );
    expect((await call("/conversations/unknown", { title: "名称" }, "PATCH")).status).toBe(404);
    expect(container.chat.messages(conversationId)).toHaveLength(2);
  });
});

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let providerServer: Server;
let container: Container;
let app: ReturnType<typeof createApp>;
let providerId: string;
const received: Array<Record<string, unknown>> = [];
const optimizedText = "请排查并修复登录失败问题，保留当前 TypeScript 技术栈，并说明验证结果。";
const deskAuth = "prompt-integration-test-token";

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    received.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = {
      id: "local-prompt-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "prompt-integration-model",
    };
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: optimizedText } }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const address = providerServer.address() as AddressInfo;
  container = await createContainer(
    {
      ...loadConfig({
        AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-prompt-integration-")),
      }),
      token: deskAuth,
    },
    { inMemory: true },
  );
  app = createApp(container);
  const provider = container.providers.create({
    name: "Local prompt integration fixture",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: ["prompt-integration-model"],
    defaultModel: "prompt-integration-model",
    source: "manual",
    enabled: true,
    apiKey: "local-test-key",
  });
  providerId = provider.id;
});

afterAll(async () => {
  await container?.dispose();
  if (providerServer) {
    await new Promise<void>((resolve, reject) => {
      providerServer.close((error) => (error ? reject(error) : resolve()));
      providerServer.closeAllConnections();
    });
  }
});

const read = async (path: string) => {
  const response = await app.request(`/api${path}`, {
    headers: { "X-AgentDesk-Token": deskAuth },
  });
  expect(response.status).toBe(200);
  return response.json();
};

it("优化 API 经真实模型适配器完成一次本地 HTTP 补全，不创建聊天或任务", async () => {
  const conversationsBefore = await read("/conversations");
  const tasksBefore = await read("/tasks");
  const text = "帮我修复登录失败的问题，保留 TypeScript。";
  const response = await app.request("/api/prompt-optimizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": deskAuth },
    body: JSON.stringify({
      text,
      agent: "code",
      modelSelection: {
        providerId,
        model: "prompt-integration-model",
        reasoningEffort: "medium",
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ optimizedText });
  expect(received).toHaveLength(1);
  const request = received[0]!;
  expect(request.model).toBe("prompt-integration-model");
  expect(request.tools ?? []).toEqual([]);
  const messages = request.messages as Array<{ role: string; content: string }>;
  const user = messages.find((message) => message.role === "user");
  expect(user).toBeDefined();
  expect(Object.values(JSON.parse(user!.content) as Record<string, unknown>)).toContain(text);
  expect(await read("/conversations")).toEqual(conversationsBefore);
  expect(await read("/tasks")).toEqual(tasksBefore);
});

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  buildModel,
  type CompleteTextResult,
  type CompleteOptions,
  type ModelResolver,
  type ResolvedModel,
} from "@agentdesk/agent-core";
import {
  AppError,
  ErrorCode,
  MAX_PROMPT_OPTIMIZATION_CHARS,
  type PromptOptimizationRequest,
} from "@agentdesk/shared";
import { PromptOptimizationService } from "../src/services/prompt-optimization";
import { promptOptimizationRoutes } from "../src/http/routes/prompt-optimizations";

const selected: ResolvedModel = {
  providerId: "selected-provider",
  providerName: "selected",
  model: buildModel(
    {
      id: "selected-provider",
      name: "selected",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
    },
    "Custom-Case-Sensitive",
  ),
  apiKey: "test",
};
const input: PromptOptimizationRequest = {
  text: "  请修改 src/login.ts，保留 @review 与 {{username}}。\n```ts\nconst value = 1;\n```\n",
  agent: "code",
  modelSelection: {
    providerId: selected.providerId,
    model: selected.model.id,
    reasoningEffort: "medium",
  },
};

function setup(result: CompleteTextResult = { text: input.text, stopReason: "stop" }) {
  const resolve = vi.fn<ModelResolver["resolve"]>().mockResolvedValue([selected]);
  const complete = vi
    .fn<(options: CompleteOptions) => Promise<CompleteTextResult>>()
    .mockResolvedValue(result);
  const service = new PromptOptimizationService({ resolve }, { complete });
  return { resolve, complete, service };
}

describe("提示词优化服务", () => {
  it("只调用明确选中的模型一次，原文作为数据保留，优化指令与原文分离", async () => {
    const { resolve, complete, service } = setup();
    resolve.mockResolvedValue([selected, { ...selected, providerId: "unrelated" }]);
    expect(await service.optimize(input)).toEqual({ optimizedText: input.text });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(input.agent, input.modelSelection);
    expect(complete).toHaveBeenCalledTimes(1);
    const options = complete.mock.calls[0]![0];
    expect(options.models).toEqual([selected]);
    expect(JSON.parse(options.prompt as string)).toEqual({ draft: input.text });
    expect(options.systemPrompt).toContain("Do not answer questions");
    expect(options.systemPrompt).toContain("Do not invent project facts");
    expect(options.maxTokens).toBe(4096);
    expect(options.maxRetries).toBe(0);
  });

  it("没有可用模型时明确失败，不尝试备用配置", async () => {
    const { resolve, complete, service } = setup();
    resolve.mockResolvedValue([]);
    await expect(service.optimize(input)).rejects.toMatchObject({
      code: ErrorCode.ProviderUnavailable,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("输入超出所选模型上下文时拒绝请求，不截掉原文", async () => {
    const { resolve, complete, service } = setup();
    resolve.mockResolvedValue([
      { ...selected, model: { ...selected.model, contextWindow: 4096, maxTokens: 256 } },
    ]);
    await expect(
      service.optimize({ ...input, text: "保留用户原文".repeat(1000) }),
    ).rejects.toMatchObject({
      code: ErrorCode.BadRequest,
      message: expect.stringContaining("输入预算"),
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { text: "半段候选", stopReason: "length" as const },
    { text: "我需要先调用工具", stopReason: "toolUse" as const },
    { text: " \n\t", stopReason: "stop" as const },
    { text: "a".repeat(MAX_PROMPT_OPTIMIZATION_CHARS + 1), stopReason: "stop" as const },
  ])("不发布截断、工具请求、空或过长结果（$stopReason）", async (result) => {
    const { service } = setup(result);
    await expect(service.optimize(input)).rejects.toMatchObject({
      code: ErrorCode.ProviderUnavailable,
    });
  });

  it("校验原文和显式模型选择，不允许空白、过长或缺少模型的请求", async () => {
    const { resolve, service } = setup();
    for (const invalid of [
      { ...input, text: " \n " },
      { ...input, text: "a".repeat(MAX_PROMPT_OPTIMIZATION_CHARS + 1) },
      { ...input, modelSelection: undefined },
    ]) {
      await expect(service.optimize(invalid)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("请求已取消时不解析模型或调用供应商", async () => {
    const { resolve, complete, service } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(service.optimize(input, controller.signal)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      details: { reason: "cancelled" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("进行中的取消传到模型，即使模型迟到返回也不发布结果", async () => {
    const { resolve, complete } = setup();
    let finish: ((result: CompleteTextResult) => void) | undefined;
    complete.mockImplementation(
      () =>
        new Promise((resolveResult) => {
          finish = resolveResult;
        }),
    );
    const service = new PromptOptimizationService({ resolve }, { complete });
    const controller = new AbortController();
    const pending = service.optimize(input, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      details: { reason: "cancelled" },
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    expect(complete.mock.calls[0]![0].signal?.aborted).toBe(true);
    finish!({ text: "迟到结果", stopReason: "stop" });
    await rejected;
  });

  it("SDK 不响应取消时仍按总超时结束等待，并通知其 signal", async () => {
    const { resolve, complete } = setup();
    complete.mockImplementation(() => new Promise(() => {}));
    const service = new PromptOptimizationService({ resolve }, { complete, timeoutMs: 25 });
    await expect(service.optimize(input)).rejects.toMatchObject({
      code: ErrorCode.ServiceUnavailable,
      details: { reason: "timeout" },
    });
    expect(complete.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it("应用关停会取消请求，不返回候选", async () => {
    const { resolve, complete } = setup();
    complete.mockImplementation(() => new Promise(() => {}));
    const shutdown = new AbortController();
    const service = new PromptOptimizationService(
      { resolve },
      { complete, shutdownSignal: shutdown.signal },
    );
    const rejected = expect(service.optimize(input)).rejects.toMatchObject({
      code: ErrorCode.ServiceUnavailable,
      details: { reason: "shutdown" },
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    shutdown.abort();
    await rejected;
  });

  it("供应商抛出异常时不重试，也不把敏感错误原文返回浏览器", async () => {
    const { complete, service } = setup();
    complete.mockRejectedValue(new Error("secret API key from provider"));
    await expect(service.optimize(input)).rejects.toMatchObject({
      code: ErrorCode.ProviderUnavailable,
      message: "提示词优化失败，请检查所选模型配置或稍后重试",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

it("优化路由拒绝非法 JSON，并把请求 signal 交给独立服务", async () => {
  const { service } = setup({ text: "候选", stopReason: "stop" });
  const optimize = vi.spyOn(service, "optimize");
  const app = new Hono().route("/api", promptOptimizationRoutes({ promptOptimization: service }));
  app.onError((error, c) =>
    error instanceof AppError ? c.json(error.toBody(), 400) : c.json({ error: error.message }, 500),
  );
  const invalid = await app.request("/api/prompt-optimizations", {
    method: "POST",
    body: "{",
  });
  expect(invalid.status).toBe(400);
  expect(optimize).not.toHaveBeenCalled();
  const response = await app.request("/api/prompt-optimizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(await response.json()).toEqual({ optimizedText: "候选" });
  expect(optimize).toHaveBeenCalledWith(input, expect.any(AbortSignal));
});

it("真实 HTTP 客户端断连会取消单轮模型请求", async () => {
  const { complete, service } = setup();
  complete.mockImplementation(() => new Promise(() => {}));
  const app = new Hono().route("/api", promptOptimizationRoutes({ promptOptimization: service }));
  app.onError((error, c) =>
    c.json(error instanceof AppError ? error.toBody() : { error: error.message }, 409),
  );
  let server: Server | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0, overrideGlobalObjects: false },
      (info) => resolve(info.port),
    ) as Server;
  });
  const client = new AbortController();
  try {
    const response = fetch(`http://127.0.0.1:${port}/api/prompt-optimizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: client.signal,
    });
    const rejected = expect(response).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const modelSignal = complete.mock.calls[0]![0].signal!;
    expect(modelSignal.aborted).toBe(false);
    client.abort();
    await rejected;
    await vi.waitFor(() => expect(modelSignal.aborted).toBe(true));
  } finally {
    client.abort();
    server?.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

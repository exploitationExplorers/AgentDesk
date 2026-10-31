import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import type { AgentModelBinding, Provider } from "@agentdesk/shared";
import App, { type AppProps } from "../src/interactive/App.js";
import { defaultModelOption, modelOptions } from "../src/interactive/slash-commands.js";
import {
  jsonResponse,
  mockApi,
  readBody,
  testState,
  type TestInstance,
} from "./interactive-helpers.js";

const providers: Provider[] = [
  {
    id: "relay",
    name: "测试中转",
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    models: ["model-a", "model-b"],
    defaultModel: "model-a",
    source: "manual",
    enabled: true,
    hasKey: true,
    createdAt: "2026-01-01",
  },
];
const theme = { interactive: true, color: false, motion: false, emoji: false };

async function waitFor(instance: TestInstance, predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (predicate(instance.lastFrame() ?? "")) return;
    await delay(10);
  }
  throw new Error(`等待超时：\n${instance.lastFrame()}`);
}
async function key(instance: TestInstance, value: string) {
  instance.stdin.write(value);
  await delay(35);
}
async function submit(instance: TestInstance, value: string) {
  await key(instance, value);
  await key(instance, "\r");
}

async function setup(
  t: TestContext,
  overrides: Partial<AppProps> = {},
  handler?: (path: string, options: RequestInit) => Response | Promise<Response> | undefined,
) {
  const requests: { path: string; options: RequestInit }[] = [];
  const chats: Record<string, unknown>[] = [];
  const instance = render(
    createElement(App, {
      state: testState,
      theme,
      model: "model-a",
      version: "1.2.3",
      conversationId: "current",
      apiRequest: mockApi(async (_state, path, options) => {
        requests.push({ path, options });
        const custom = handler ? await handler(path, options) : undefined;
        if (custom) return custom;
        if (path === "/providers") return jsonResponse(providers);
        if (path === "/agent-bindings") return jsonResponse([]);
        if (path.startsWith("/approvals")) return jsonResponse([]);
        if (path === "/chat") {
          chats.push(readBody(options));
          return new Response("");
        }
        if (path === "/conversations")
          return jsonResponse([
            { id: "old", title: "旧会话", updatedAt: "2026-01-01", createdAt: "2026-01-01" },
          ]);
        if (path.endsWith("/messages"))
          return jsonResponse([
            { role: "user", content: "旧问题" },
            { role: "assistant", content: "旧回答" },
          ]);
        throw new Error(`未预期的接口：${path}`);
      }),
      consumeSse: async (_body, emit) => {
        await emit({ type: "conversation", conversationId: "created" });
        await emit({ type: "text_delta", agent: "orchestrator", delta: "已回复" });
        await emit({ type: "done", messageId: "answer" });
      },
      ...overrides,
    }),
  );
  t.after(() => instance.unmount());
  await waitFor(instance, (frame) => frame.includes("空闲"));
  return { instance, requests, chats };
}

test("/model 菜单筛选和选择改变下一次真实请求，Esc 不改变模型", async (t) => {
  const { instance, chats, requests } = await setup(t);
  await submit(instance, "/model");
  await waitFor(instance, (frame) => frame.includes("选择模型"));
  await key(instance, "model-b");
  await key(instance, "\r");
  await waitFor(instance, (frame) => frame.includes("当前会话已切换到 model-b"));
  await submit(instance, "第一轮");
  await waitFor(instance, () => chats.length === 1);
  assert.deepEqual(chats[0]?.modelSelection, { providerId: "relay", model: "model-b" });
  await submit(instance, "/model");
  await waitFor(instance, (frame) => frame.includes("选择模型"));
  await key(instance, "\x1b");
  await submit(instance, "第二轮");
  await waitFor(instance, () => chats.length === 2);
  assert.deepEqual(chats[1]?.modelSelection, chats[0]?.modelSelection);
  assert.equal(
    requests.filter((item) => item.path === "/agent-bindings" && item.options.method === "PUT")
      .length,
    0,
  );
});

test("Tab 补全命令后支持参数，/model default 清除会话覆盖", async (t) => {
  const { instance, chats } = await setup(t);
  await key(instance, "/mod");
  await key(instance, "\t");
  await key(instance, "relay/Custom-Model");
  await key(instance, "\r");
  await waitFor(instance, (frame) => frame.includes("当前会话已切换到 Custom-Model"));
  await submit(instance, "自定义模型");
  assert.deepEqual(chats[0]?.modelSelection, { providerId: "relay", model: "Custom-Model" });
  await submit(instance, "/model default");
  await waitFor(instance, (frame) => frame.includes("已恢复默认模型"));
  await submit(instance, "默认模型");
  await waitFor(instance, () => chats.length === 2);
  assert.equal(chats[1]?.modelSelection, undefined);
});

test("未知命令和帮助只在本地执行；方向键选择菜单条目", async (t) => {
  const { instance, chats } = await setup(t);
  await submit(instance, "/missing something");
  await waitFor(instance, (frame) => frame.includes("未知指令 /missing"));
  await key(instance, "/");
  await key(instance, "\x1b[B");
  await key(instance, "\r");
  await waitFor(instance, (frame) => frame.includes("选择模型"));
  await key(instance, "\x1b");
  await submit(instance, "/help");
  await waitFor(instance, (frame) => frame.includes("命令与快捷键"));
  await key(instance, "\x1b");
  assert.equal(chats.length, 0);
});

test("Ctrl+O 不污染输入，Ctrl+C 清空草稿，↑↓ 恢复输入历史与草稿", async (t) => {
  const { instance, chats } = await setup(t);
  await key(instance, "hello");
  await key(instance, "\x0f");
  await key(instance, "\r");
  await waitFor(instance, () => chats.length === 1);
  assert.equal(chats[0]?.message, "hello");
  await key(instance, "draft");
  await key(instance, "\x1b[A");
  await key(instance, "\x1b[B");
  await key(instance, "\r");
  await waitFor(instance, () => chats.length === 2);
  assert.equal(chats[1]?.message, "draft");
  await key(instance, "discard");
  await key(instance, "\x03");
  await submit(instance, "保留中文🙂");
  await waitFor(instance, () => chats.length === 3);
  assert.equal(chats[2]?.message, "保留中文🙂");
});

test("/clear 新建会话不删除历史，/resume 恢复指定会话用于后续请求", async (t) => {
  const { instance, chats, requests } = await setup(t);
  await submit(instance, "/clear");
  await waitFor(instance, (frame) => frame.includes("已开始新会话"));
  await submit(instance, "新问题");
  await waitFor(instance, () => chats.length === 1);
  assert.equal(chats[0]?.conversationId, undefined);
  await submit(instance, "/resume old");
  await waitFor(instance, (frame) => frame.includes("旧回答"));
  await submit(instance, "追问");
  await waitFor(instance, () => chats.length === 2);
  assert.equal(chats[1]?.conversationId, "old");
  assert.ok(!requests.some((item) => item.options.method === "DELETE"));
});

test("同名模型必须指定 Provider，停用或缺少密钥的模型不出现在菜单", async (t) => {
  const { instance, chats } = await setup(t, {}, (path) =>
    path === "/providers"
      ? jsonResponse([
          ...providers,
          { ...providers[0], id: "other", name: "其他中转" },
          { ...providers[0], id: "disabled", name: "停用中转", enabled: false },
          { ...providers[0], id: "no-key", name: "无密钥中转", hasKey: false },
        ])
      : undefined,
  );
  await submit(instance, "/model model-a");
  await waitFor(instance, (frame) => frame.includes("多个 Provider 提供同名模型"));
  await submit(instance, "/model");
  await waitFor(instance, (frame) => frame.includes("选择模型"));
  assert.ok(!instance.lastFrame()?.includes("停用中转"));
  assert.ok(!instance.lastFrame()?.includes("无密钥中转"));
  assert.equal(chats.length, 0);
});

test("取消正在加载的菜单后，延迟请求不会重新打开菜单", async (t) => {
  let release: ((response: Response) => void) | undefined;
  const { instance } = await setup(t, {}, (path) =>
    path === "/providers"
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : undefined,
  );
  await submit(instance, "/model");
  await waitFor(instance, (frame) => frame.includes("正在执行指令"));
  await key(instance, "\x1b");
  assert.ok(release);
  release(jsonResponse(providers));
  await delay(50);
  assert.ok(!instance.lastFrame()?.includes("选择模型"));
  await submit(instance, "/version");
  await waitFor(instance, (frame) => frame.includes("AgentDesk v1.2.3"));
});

test("模型接口失败显示错误，原模型仍然可用", async (t) => {
  const { instance, chats } = await setup(t, {}, (path) => {
    if (path === "/providers") throw new Error("模型列表不可用");
    return undefined;
  });
  await submit(instance, "/model");
  await waitFor(instance, (frame) => frame.includes("执行失败：模型列表不可用"));
  await submit(instance, "继续对话");
  await waitFor(instance, () => chats.length === 1);
  assert.equal(chats[0]?.modelSelection, undefined);
});

test("/export 输出真实历史且不会覆盖已有文件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-export-"));
  const { instance, chats } = await setup(t, { cwd: directory });
  await submit(instance, '/export "session output.md"');
  await waitFor(instance, (frame) => frame.includes("会话已导出"));
  const target = join(directory, "session output.md");
  assert.match(await readFile(target, "utf8"), /旧问题[\s\S]*旧回答/);
  await writeFile(target, "保留原文件");
  await submit(instance, '/export "session output.md"');
  await waitFor(instance, (frame) => frame.includes("EEXIST"));
  assert.equal(await readFile(target, "utf8"), "保留原文件");
  assert.equal(chats.length, 0);
});

test("查询指令调用对应服务，配置、Agent 和重命名指令生效", async (t) => {
  const { instance, requests, chats } = await setup(t, {}, (path, options) => {
    if (path === "/health")
      return jsonResponse({
        ok: true,
        version: "1",
        dataDir: "test-data",
        providers: 1,
        secretBackend: "dev-file",
      });
    if (path === "/tools")
      return jsonResponse([{ name: "fs.read", description: "读取文件", risk: "safe" }]);
    if (path === "/skills") return jsonResponse([{ name: "review", description: "检查代码" }]);
    if (path === "/memories") return jsonResponse([{ kind: "fact", text: "使用 TypeScript" }]);
    if (path === "/tasks")
      return jsonResponse([{ id: "task-1", title: "修复任务", status: "running" }]);
    if (path === "/conversations/current" && options.method === "PATCH")
      return jsonResponse({ title: readBody(options).title });
    return undefined;
  });
  for (const [command, expected] of [
    ["status", "当前状态"],
    ["context", "会话上下文"],
    ["tools", "fs.read"],
    ["skills", "检查代码"],
    ["memory", "使用 TypeScript"],
    ["tasks", "修复任务"],
    ["permissions", "工具权限与审批"],
    ["doctor", "环境诊断"],
  ]) {
    await submit(instance, `/${command}`);
    await waitFor(instance, (frame) => frame.includes(expected!));
    await key(instance, "\x1b");
  }
  await submit(instance, "/config verbose on");
  await waitFor(instance, (frame) => frame.includes("verbose 已开启"));
  await submit(instance, "/agents code");
  await waitFor(instance, (frame) => frame.includes("当前 Agent：code"));
  await submit(instance, "/rename 新名称");
  await waitFor(instance, (frame) => frame.includes("会话已重命名为：新名称"));
  assert.deepEqual(readBody(requests.find((item) => item.options.method === "PATCH")!.options), {
    title: "新名称",
  });
  assert.equal(chats.length, 0);
  await submit(instance, "编写代码");
  await waitFor(instance, () => chats.length === 1);
  assert.equal(chats[0]?.agent, "code");
});

test("默认模型遵循 Agent 绑定、总控绑定与可用 Provider 的回退顺序", () => {
  const list = [
    { ...providers[0]!, id: "disabled", enabled: false },
    { ...providers[0]!, id: "no-key", hasKey: false },
    providers[0]!,
  ];
  const bindings: AgentModelBinding[] = [
    {
      agent: "orchestrator",
      providerId: "disabled",
      model: "unavailable",
      fallbackProviderIds: ["no-key", "relay"],
    },
  ];
  assert.equal(defaultModelOption(list, bindings, "code")?.providerId, "relay");
  assert.deepEqual(
    modelOptions(list).map((item) => item.model),
    ["model-a", "model-b"],
  );
  bindings[0]!.providerId = "relay";
  bindings[0]!.model = "Custom-Model";
  assert.equal(defaultModelOption(list, bindings, "code")?.model, "Custom-Model");
});

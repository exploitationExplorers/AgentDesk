import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  ToolRegistry,
  toWireName,
  type ModelResolver,
  type ToolContext,
} from "@agentdesk/agent-core";
import type { Project } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { RepositorySource, sourceWindow } from "../src/services/repo-reading/source";
import { RepoReadingService, normalizeReadingSlices } from "../src/services/repo-reading/service";
import { registerRepoReadingTools } from "../src/agents/repo-reading-tools";
import type { fetchPublicSource } from "../src/services/public-fetch";

let root: string;
let database: DbHandle;
let source: RepositorySource;
let reading: RepoReadingService;
let faux: FauxProviderRegistration;
let models: ModelResolver;
const ctx: ToolContext = { agent: "code", emit: () => {}, requestApproval: async () => false };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentdesk-reading-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "# Demo\nA repository for reading.");
  await writeFile(
    join(root, "src/main.ts"),
    Array.from({ length: 90 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
  );
  await writeFile(join(root, "src/helper.py"), "def helper():\n    return 'value0'\n");
  await writeFile(join(root, ".env"), "PRIVATE_SECRET=hidden");
  database = openDatabase(root);
  source = new RepositorySource({
    list: () => [{ id: "p1", name: "demo", path: root } as Project],
  });
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  models = {
    resolve: async () => [
      { providerId: "faux", providerName: "faux", apiKey: "test", model: faux.getModel() },
    ],
  };
  reading = new RepoReadingService(database.db, source, models);
});
afterEach(async () => {
  faux.unregister();
  database.close();
  // 只清理本测试创建的临时目录。
  expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  await rm(root, { recursive: true, force: true });
});

async function start() {
  const opened = await reading.open("p1");
  const sliced = await reading.slice(opened.sessionId, "src/main.ts");
  return { id: opened.sessionId, slices: sliced.slices };
}

it("按行读取大文件，搜索其他语言，并阻止越界和凭据读取", async () => {
  const opened = await reading.open(root);
  expect(opened.files).toContain("src/helper.py");
  expect(opened.files).not.toContain(".env");
  const window = await reading.read(opened.sessionId, "src/main.ts", 71, 75);
  expect(window.content).toContain("71: export const value70");
  expect(window.content).not.toContain("value0");
  expect(window.hash).toHaveLength(64);
  expect(window.nextLine).toBe(76);
  expect(window.truncated).toBe(false);
  expect((await reading.search(opened.sessionId, "helper")).hits).toEqual([
    { path: "src/helper.py", line: 1, text: "def helper():" },
  ]);
  for (const path of ["../outside.ts", "src/../../outside.ts", ".env", "C:/Windows/system.ini"]) {
    await expect(reading.read(opened.sessionId, path)).rejects.toThrow();
  }
  await expect(reading.read(opened.sessionId, "src/main.ts", 200)).rejects.toThrow("行号");
});

it("不跟随通向项目外的目录链接", async () => {
  const external = await mkdtemp(join(tmpdir(), "agentdesk-reading-external-"));
  try {
    await writeFile(join(external, "secret.ts"), "private");
    await symlink(external, join(root, "outside"), "junction");
    const opened = await reading.open("demo");
    expect(opened.files).not.toContain("outside/secret.ts");
    await expect(reading.read(opened.sessionId, "outside/secret.ts")).rejects.toThrow();
  } finally {
    expect(resolve(external).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    await rm(external, { recursive: true, force: true });
  }
});

it("逻辑分段补齐缺口，拒绝重叠，不把按行兜底声称为模型分段", async () => {
  const slices = normalizeReadingSlices(
    [
      { startLine: 8, endLine: 9, title: "second", role: "" },
      { startLine: 2, endLine: 4, title: "first", role: "" },
    ],
    10,
  );
  expect(slices.map((s) => [s.startLine, s.endLine])).toEqual([
    [1, 7],
    [8, 10],
  ]);
  expect(() =>
    normalizeReadingSlices(
      [
        { startLine: 1, endLine: 5, title: "a", role: "" },
        { startLine: 4, endLine: 7, title: "b", role: "" },
      ],
      10,
    ),
  ).toThrow("重叠");
  const { id } = await start();
  expect(reading.slices(id, "src/main.ts").strategy).toBe("lines");
  await expect(reading.slice(id, "src/main.ts", undefined, slices)).rejects.toThrow("hash");
});

it("进度和当前片段跨数据库重启恢复，切换不会自动标记读懂", async () => {
  const { id, slices } = await start();
  await reading.plan(id, "已读取入口源码", [{ path: "src/main.ts", reason: "主入口" }]);
  expect(await reading.focus(id, slices[0]!.id)).toMatchObject({ nextSliceId: slices[1]!.id });
  expect(await reading.focus(id, slices[1]!.id)).toMatchObject({ nextSliceId: slices[2]!.id });
  expect(reading.slices(id, "src/main.ts").slices[0]!.status).toBe("reading");
  await reading.focus(id, slices[0]!.id, true);
  await reading.focus(id, slices[1]!.id);
  database.close();
  database = openDatabase(root);
  reading = new RepoReadingService(database.db, source, models);
  expect(reading.list().sessions[0]!.sessionId).toBe(id);
  const restored = await reading.focus(id);
  expect(restored.current?.sliceId).toBe(slices[1]!.id);
  expect(restored.overview).toBe("已读取入口源码");
  expect(reading.slices(id, "src/main.ts").slices[0]!.status).toBe("done");
  await expect(reading.focus(id, "foreign")).rejects.toThrow("不属于");
});

it("源码变化后拒绝旧切片问答和旧 hash 分段，明确重新分段后可继续", async () => {
  const { id } = await start();
  const original = await reading.read(id, "src/main.ts");
  await writeFile(join(root, "src/main.ts"), "export const changed = true;\n");
  await expect(reading.focus(id)).rejects.toThrow("源码已变化");
  await expect(reading.ask(id, "讲解", "brief", ctx)).rejects.toThrow("源码已变化");
  await expect(reading.slice(id, "src/main.ts", original.hash)).rejects.toThrow("源码已变化");
  expect((await reading.summary(id)).files[0]!.stale).toBe(true);
  await reading.slice(id, "src/main.ts");
  expect((await reading.summary(id)).files[0]!.stale).toBe(false);
});

it("独立问答只回放当前片段，可检索跨文件调用，拒绝模型生成的写操作", async () => {
  const { id, slices } = await start();
  const prompts: string[] = [];
  faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("第一段的独立记录 A_ONLY"));
    },
  ]);
  await reading.ask(id, "FIRST_ONLY_QUESTION", "brief", ctx);
  await reading.focus(id, slices[1]!.id);
  faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall(toWireName("reading.search"), { query: "helper" }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      prompts.push(JSON.stringify(context));
      return fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), { path: "src/main.ts", content: "changed" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      prompts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("调用点位于 src/helper.py:1。"));
    },
  ]);
  const answer = await reading.ask(id, "helper 定义在哪里", "deep", ctx);
  expect(answer.answer).toContain("src/helper.py:1");
  expect(answer.inspectedTools).toContain("reading.search");
  expect(prompts[1]).not.toContain("FIRST_ONLY_QUESTION");
  expect(prompts[1]).not.toContain("A_ONLY");
  expect(prompts[2]).toContain("src/helper.py");
  expect(prompts[3]).toContain("未知工具");
  expect((await reading.read(id, "src/main.ts")).content).toContain("value0");
  await reading.focus(id, slices[0]!.id);
  faux.setResponses([
    (context) => {
      expect(JSON.stringify(context)).toContain("A_ONLY");
      expect(JSON.stringify(context)).not.toContain("helper 定义在哪里");
      return fauxAssistantMessage(fauxText("继续第一段"));
    },
  ]);
  await reading.ask(id, "继续", "brief", ctx);
});

it("取消讲解不会落下半条问答，也不会改变源码", async () => {
  const { id } = await start();
  const controller = new AbortController();
  faux.setResponses([
    () => {
      controller.abort();
      return fauxAssistantMessage(fauxText("不应保存"));
    },
  ]);
  await expect(
    reading.ask(id, "取消这个问题", "brief", { ...ctx, signal: controller.signal }),
  ).rejects.toThrow();
  const summary = await reading.summary(id);
  expect(JSON.stringify(summary)).not.toContain("取消这个问题");
});

it("工具入口校验空查询、分页和切片大小，范围输出明确标记截断", async () => {
  const registry = new ToolRegistry();
  registerRepoReadingTools(registry, reading);
  const { id } = await start();
  await expect(
    registry.get("reading.search")!.execute({ sessionId: id, query: " " }, ctx),
  ).rejects.toThrow();
  await expect(
    registry.get("reading.files")!.execute({ sessionId: id, offset: -1 }, ctx),
  ).rejects.toThrow();
  const file = {
    path: "large.ts",
    hash: "hash",
    totalLines: 300,
    content: Array(300).fill("line").join("\n"),
  };
  expect(sourceWindow(file, 1, 300)).toMatchObject({
    endLine: 160,
    nextLine: 161,
    truncated: true,
  });
  expect(sourceWindow({ ...file, content: "x".repeat(20_000), totalLines: 1 })).toMatchObject({
    partialLine: true,
    truncated: true,
  });
});

describe("公开 GitHub 读取", () => {
  it("固定 commit，忽略 symlink，并只读取固定版本的文件", async () => {
    const sha = "a".repeat(40);
    const fetcher = vi.fn<typeof fetchPublicSource>(async (url) => {
      const value = url.endsWith("/demo/repo")
        ? { default_branch: "main" }
        : url.includes("/commits/")
          ? { sha }
          : url.includes("/git/trees/")
            ? {
                truncated: false,
                tree: [
                  { type: "blob", mode: "100644", path: "src/main.ts" },
                  { type: "blob", mode: "120000", path: "src/link.ts" },
                  { type: "blob", mode: "100644", path: ".env" },
                ],
              }
            : null;
      return {
        status: 200,
        contentType: "text/plain",
        headers: {},
        text: value ? JSON.stringify(value) : "export const remote = true;",
      };
    });
    const remote = new RepositorySource({ list: () => [] }, fetcher);
    const opened = await remote.open("https://github.com/demo/repo");
    expect(opened).toMatchObject({ kind: "github", commit: sha });
    expect((await remote.files(opened)).files).toEqual(["src/main.ts"]);
    const read = await remote.read(opened, "src/main.ts");
    expect(fetcher.mock.calls.at(-1)![0]).toBe(
      `https://raw.githubusercontent.com/demo/repo/${sha}/src/main.ts`,
    );
    expect(read.url).toContain(`/blob/${sha}/`);
    for (const url of [
      "https://localhost/demo/repo",
      "http://github.com/demo/repo",
      "https://user:pass@github.com/demo/repo",
      "https://github.com/demo/repo?ref=main",
    ])
      await expect(remote.open(url)).rejects.toThrow();
  });

  it("GitHub 限流停止读取，不把失败当成空仓库", async () => {
    const fetcher = vi.fn<typeof fetchPublicSource>(async () => ({
      status: 429,
      headers: {},
      contentType: "application/json",
      text: "{}",
    }));
    const remote = new RepositorySource({ list: () => [] }, fetcher);
    await expect(remote.open("https://github.com/demo/repo")).rejects.toThrow("429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

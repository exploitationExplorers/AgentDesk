import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationGroup, Project } from "@agentdesk/shared";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { openDatabase, type DbHandle } from "../src/db/client";
import { Collection } from "../src/db/collection";
import { messages } from "../src/db/schema";
import { createApp } from "../src/http/app";
import { ConversationService } from "../src/services/conversations";

const oldConversation = (id: string, title = id): Conversation => ({
  id,
  title,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

const project = (id: string, path: string): Project => ({
  id,
  path,
  name: id,
  platform: "unknown",
  remoteUrl: null,
  host: null,
  owner: null,
  repo: null,
  branch: null,
  dirtyFiles: 0,
  ahead: 0,
  behind: 0,
  lastCommit: null,
  pinned: false,
  tags: [],
  scannedAt: "2025-01-01T00:00:00.000Z",
  stars: null,
  prevStars: null,
});

describe("会话组织", () => {
  let db: DbHandle;
  let conversations: ConversationService;
  beforeEach(() => {
    db = openDatabase(":memory:");
    conversations = new ConversationService(db.db);
  });
  afterEach(() => db.close());

  it("旧会话补全默认值，分组、置顶和归档由存储重新读取", () => {
    const collection = new Collection<Conversation>(db.db, "conversations");
    collection.put(oldConversation("old"));
    collection.put({ ...oldConversation("new"), updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(conversations.get("old")).toMatchObject({
      pinned: false,
      archived: false,
      groupId: null,
      projectId: null,
    });
    const group = conversations.createGroup({ name: " 客户项目 " });
    conversations.patch("old", { groupId: group.id, pinned: true });
    const restored = new ConversationService(db.db);
    expect(restored.list().map((item) => item.id)).toEqual(["old", "new"]);
    expect(restored.list({ groupId: group.id })[0]?.id).toBe("old");
    restored.patch("old", { archived: true });
    expect(restored.list().map((item) => item.id)).toEqual(["new"]);
    expect(restored.list({ archived: "archived" })[0]).toMatchObject({ id: "old", pinned: true });
    expect(restored.list({ archived: "all" })).toHaveLength(2);
    restored.patch("old", { archived: false });
    expect(restored.list()[0]?.id).toBe("old");
  });

  it("搜索标题和正文，按分组与归档范围过滤，百分号按普通字符匹配", () => {
    conversations.put(oldConversation("title", "升级 AgentDesk"));
    conversations.put(oldConversation("body", "另一段会话"));
    db.db
      .insert(messages)
      .values({
        id: "m",
        conversationId: "body",
        role: "user",
        content: "讨论 100% 完成的预算方案",
        agent: null,
        toolCalls: [],
        createdAt: "2025-01-01T00:00:00.000Z",
      })
      .run();
    expect(conversations.list({ search: "agentdesk" }).map((item) => item.id)).toEqual(["title"]);
    expect(conversations.list({ search: "预算" }).map((item) => item.id)).toEqual(["body"]);
    expect(conversations.list({ search: "%" }).map((item) => item.id)).toEqual(["body"]);
    expect(conversations.list({ search: "' OR 1=1 --" })).toEqual([]);
    const group = conversations.createGroup({ name: "Budget" });
    conversations.patch("body", { groupId: group.id, archived: true });
    expect(conversations.list({ search: "预算" })).toEqual([]);
    expect(
      conversations.list({ search: "预算", archived: "archived", groupId: group.id }),
    ).toHaveLength(1);
    expect(
      conversations.list({ archived: "all", groupId: "ungrouped" }).map((item) => item.id),
    ).toEqual(["title"]);
  });

  it("分组可改名且删除不会删除会话或消息", () => {
    const group = conversations.createGroup({ name: "第一组" });
    conversations.put({ ...oldConversation("a"), groupId: group.id });
    conversations.put({ ...oldConversation("b"), groupId: group.id, archived: true });
    db.db
      .insert(messages)
      .values({
        id: "m",
        conversationId: "a",
        role: "user",
        content: "保留",
        agent: null,
        toolCalls: [],
        createdAt: "2025-01-01T00:00:00.000Z",
      })
      .run();
    expect(conversations.renameGroup(group.id, { name: " 第二组 " }).name).toBe("第二组");
    expect(() => conversations.createGroup({ name: "第二组" })).toThrow(/同名/);
    conversations.deleteGroup(group.id);
    expect(conversations.listGroups()).toEqual([]);
    expect(conversations.list({ archived: "all", groupId: "ungrouped" })).toHaveLength(2);
    expect(db.db.select().from(messages).all()).toHaveLength(1);
  });

  it("拒绝无效项目与分组，项目删除后给出明确提示", () => {
    conversations.put(oldConversation("c"));
    expect(() => conversations.patch("c", { groupId: "missing" })).toThrow(/分组不存在/);
    expect(() => conversations.patch("c", { projectId: "missing" })).toThrow(/项目不存在/);
    const projects = new Collection<Project>(db.db, "projects");
    projects.put(project("p", "D:/projects/demo"));
    conversations.patch("c", { projectId: "p" });
    expect(conversations.projectWorkspace("c")).toBe("D:/projects/demo");
    projects.delete("p");
    expect(() => conversations.projectWorkspace("c")).toThrow(/已移除/);
    conversations.patch("c", { projectId: null });
    expect(conversations.projectWorkspace("c")).toBeUndefined();
  });

  it("整理旧会话不意外清除其尚未迁移的工作区继承", () => {
    new Collection<Conversation>(db.db, "conversations").put(oldConversation("legacy"));
    conversations.patch("legacy", { pinned: true });
    expect(conversations.hasProjectBinding("legacy")).toBe(false);
    conversations.patch("legacy", { projectId: null });
    expect(conversations.hasProjectBinding("legacy")).toBe(true);
  });
});

describe("会话管理 API", () => {
  let container: Container;
  let root: string;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "agentdesk-conversations-"));
    container = await createContainer(
      { ...loadConfig({ AGENTDESK_DATA_DIR: root }), token: "test-conversations" },
      { inMemory: true },
    );
    app = createApp(container);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await container.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown, method = "GET") =>
    app.request(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test-conversations" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("管理路由支持旧的重命名请求、分组CRUD和归档过滤", async () => {
    container.chat.conversations.put(oldConversation("route", "原名称"));
    const created = await call("/conversation-groups", { name: "API分组" }, "POST");
    expect(created.status).toBe(201);
    const group = (await created.json()) as ConversationGroup;
    const renamed = await call("/conversations/route", { title: "新名称" }, "PATCH");
    expect(await renamed.json()).toMatchObject({ title: "新名称" });
    expect(
      (
        await call(
          "/conversations/route",
          { groupId: group.id, pinned: true, archived: true },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const archived = (await (
      await call("/conversations?archived=archived&search=新名称")
    ).json()) as Conversation[];
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: "route", groupId: group.id, pinned: true });
    expect((await call(`/conversation-groups/${group.id}`, { name: "改名" }, "PATCH")).status).toBe(
      200,
    );
    expect((await call(`/conversation-groups/${group.id}`, undefined, "DELETE")).status).toBe(204);
    expect(await (await call("/conversations/route")).json()).toMatchObject({ groupId: null });
    expect((await call("/conversations/route", {}, "PATCH")).status).toBe(400);
    expect((await call("/conversations/route", { pinned: "yes" }, "PATCH")).status).toBe(400);
    expect((await call("/conversations/route", { title: " " }, "PATCH")).status).toBe(400);
    expect((await call("/conversations/missing")).status).toBe(404);
    expect((await call("/conversations?archived=invalid")).status).toBe(400);
  });

  it("关联项目实际注入后续聊天的工作区，解除关联后不沿用旧项目", async () => {
    const workspace = join(root, "project");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "AGENTS.md"), "conversation-project-rule");
    new Collection<Project>(container.dbHandle.db, "projects").put(project("linked", workspace));
    container.chat.conversations.put(oldConversation("workspace"));
    const contexts: Array<string | undefined> = [];
    vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
    vi.spyOn(container.orchestrator, "run").mockImplementation(async (options) => {
      contexts.push(options.context);
      return { status: "completed", text: "完成", agent: "code", toolCalls: [] };
    });
    expect((await call("/conversations/workspace", { projectId: "linked" }, "PATCH")).status).toBe(
      200,
    );
    const first = await call(
      "/chat",
      { conversationId: "workspace", message: "检查当前项目" },
      "POST",
    );
    expect(await first.text()).toContain('"type":"done"');
    expect(contexts[0]).toContain("conversation-project-rule");
    expect((await call("/conversations/workspace", { projectId: null }, "PATCH")).status).toBe(200);
    const second = await call(
      "/chat",
      { conversationId: "workspace", message: "现在未关联项目" },
      "POST",
    );
    expect(await second.text()).toContain('"type":"done"');
    expect(contexts[1] ?? "").not.toContain("conversation-project-rule");
  });

  it("生成期间调整置顶不会被完成事件覆盖，更换项目会被拒绝", async () => {
    let started!: () => void;
    let finish!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
    vi.spyOn(container.orchestrator, "run").mockImplementation(async () => {
      started();
      await release;
      return { status: "completed", text: "ok", agent: "code", toolCalls: [] };
    });
    container.chat.conversations.put(oldConversation("active"));
    const running = container.chat.send(
      { conversationId: "active", message: "开始" },
      () => {},
      new AbortController().signal,
    );
    await didStart;
    expect((await call("/conversations/active", { projectId: null }, "PATCH")).status).toBe(409);
    expect(
      (await call("/conversations/active", { title: "用户更新的标题", pinned: true }, "PATCH"))
        .status,
    ).toBe(200);
    finish();
    await running;
    expect(container.chat.getConversation("active")).toMatchObject({
      title: "用户更新的标题",
      pinned: true,
    });
  });

  it("一键清空删除列表会话，进行中的收尾不会把会话写回", { timeout: 15_000 }, async () => {
    let started!: () => void;
    let finish!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
    vi.spyOn(container.orchestrator, "run").mockImplementation(async () => {
      started();
      await release;
      return { status: "completed", text: "ok", agent: "code", toolCalls: [] };
    });
    container.chat.conversations.put(oldConversation("keep-clear-a", "A"));
    container.chat.conversations.put(oldConversation("keep-clear-b", "B"));
    container.chat.conversations.put(oldConversation("keep-clear-live", "Live"));
    const running = container.chat.send(
      { conversationId: "keep-clear-live", message: "生成中" },
      () => {},
      new AbortController().signal,
    );
    await didStart;
    const cleared = await call(
      "/conversations/clear",
      { ids: ["keep-clear-a", "keep-clear-b", "keep-clear-live"] },
      "POST",
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      deleted: ["keep-clear-a", "keep-clear-b", "keep-clear-live"],
      skipped: [],
    });
    expect(container.chat.listConversations().map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["keep-clear-a", "keep-clear-b", "keep-clear-live"]),
    );
    finish();
    await running;
    expect(() => container.chat.getConversation("keep-clear-live")).toThrow(/不存在/);
    expect(container.chat.listConversations().map((item) => item.id)).not.toContain(
      "keep-clear-live",
    );
  });
});

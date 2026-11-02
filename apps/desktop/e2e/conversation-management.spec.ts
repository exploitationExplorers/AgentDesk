import { expect, test } from "@playwright/test";
import type { Conversation, ConversationGroup, Project, ProjectInsight } from "@agentdesk/shared";
import { resolve } from "node:path";

const date = "2026-11-02T08:00:00.000Z";
const project: Project = {
  id: "test-project",
  name: "AgentDesk 演示",
  path: "D:/projects/demo",
  platform: "unknown",
  remoteUrl: null,
  host: null,
  owner: null,
  repo: null,
  branch: "main",
  dirtyFiles: 0,
  ahead: 0,
  behind: 0,
  lastCommit: null,
  pinned: false,
  tags: [],
  scannedAt: date,
  stars: null,
  prevStars: null,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000)),
  );
  await page.route("**/api/projects", (route) => route.fulfill({ json: [project] }));
});

test("会话分组、置顶、项目关联和归档可保存，正文搜索和删除分组可用", async ({ page }) => {
  let groups: ConversationGroup[] = [];
  let conversation: Conversation = {
    id: "conversation-demo",
    title: "发布准备",
    createdAt: date,
    updatedAt: date,
  };
  await page.route("**/api/conversation-groups**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      groups.push({
        id: "group-demo",
        name: route.request().postDataJSON().name,
        createdAt: date,
        updatedAt: date,
      });
      return route.fulfill({ status: 201, json: groups[0] });
    }
    if (method === "DELETE") {
      groups = [];
      conversation.groupId = null;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: groups });
  });
  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/messages"))
      return route.fulfill({
        json: [
          {
            id: "message",
            conversationId: conversation.id,
            role: "user",
            content: "正文中的预算讨论",
            agent: null,
            toolCalls: [],
            createdAt: date,
          },
        ],
      });
    if (url.pathname.endsWith("/workbench"))
      return route.fulfill({
        json: {
          conversation,
          workspace: null,
          task: null,
          runs: [],
          artifacts: [],
          pendingApprovals: 0,
          activity: null,
          context: null,
          contextError: "尚未配置模型",
          latestUsage: null,
          lastCompaction: null,
          usedTools: [],
        },
      });
    if (route.request().method() === "PATCH") {
      conversation = { ...conversation, ...route.request().postDataJSON() };
      return route.fulfill({ json: conversation });
    }
    if (url.pathname === "/api/conversations") {
      const search = url.searchParams.get("search") ?? "";
      const group = url.searchParams.get("groupId");
      const archived = url.searchParams.get("archived") === "archived";
      const matches =
        !!conversation.archived === archived &&
        (!group ||
          group === conversation.groupId ||
          (group === "ungrouped" && !conversation.groupId)) &&
        `${conversation.title} 正文中的预算讨论`.includes(search);
      return route.fulfill({ json: matches ? [conversation] : [] });
    }
    return route.fulfill({ json: conversation });
  });
  await page.goto("/#/");
  const sidebar = page.getByRole("complementary", { name: "会话列表" });
  await sidebar.getByRole("button", { name: "新建会话分组" }).click();
  await page.getByRole("textbox", { name: "分组名称" }).fill("客户项目");
  await page.getByRole("button", { name: "保存分组" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "管理会话：发布准备" }).click();
  await page.getByRole("textbox", { name: "会话名称" }).fill("客户发布准备");
  await page.getByRole("combobox", { name: "所属分组" }).selectOption("group-demo");
  await page.getByRole("combobox", { name: "关联项目" }).selectOption(project.id);
  await page.getByRole("checkbox", { name: "置顶会话" }).check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(sidebar.getByRole("heading", { name: "置顶" })).toBeVisible();
  expect(conversation).toMatchObject({
    pinned: true,
    groupId: "group-demo",
    projectId: project.id,
  });
  await page.reload();
  await sidebar.getByRole("textbox", { name: "搜索会话" }).fill("预算");
  await expect(sidebar.getByRole("button", { name: "管理会话：客户发布准备" })).toBeVisible();
  await sidebar.getByRole("textbox", { name: "搜索会话" }).fill("无匹配内容");
  await expect(sidebar.getByText("没有找到匹配的会话")).toBeVisible();
  await sidebar.getByRole("textbox", { name: "搜索会话" }).fill("");
  await sidebar.getByRole("button", { name: "管理会话：客户发布准备" }).click();
  await page.getByRole("checkbox", { name: "归档会话" }).check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "管理会话：客户发布准备" })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "查看已归档", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "管理会话：客户发布准备" })).toBeVisible();
  await sidebar.getByRole("combobox", { name: "筛选会话分组" }).selectOption("group-demo");
  await sidebar.getByRole("button", { name: "管理当前分组" }).click();
  await page.getByRole("button", { name: "删除分组", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await sidebar.getByRole("button", { name: /客户发布准备 AgentDesk/ }).click();
  await expect(page.getByText("正文中的预算讨论", { exact: true })).toBeVisible();
  expect(conversation.groupId).toBeNull();
  await page.screenshot({
    path: resolve("../../.workflow/.scratchpad/session-workbench/conversation-management.png"),
    fullPage: true,
  });
});

test("资料读取失败可粘贴正文，分析历史恢复后展示依据并创建所选任务", async ({ page }) => {
  const sourceText =
    "这份产品资料建议按照项目整理会话，增加分组和归档，并记录每次任务的验收标准以便复查。";
  let records: ProjectInsight[] = [];
  let ready = false;
  let submitted: unknown;
  let selected: string[] = [];
  await page.route("**/api/project-insights**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/tasks")) {
      selected = route.request().postDataJSON().ids;
      records[0]!.suggestions[0]!.taskId = "created-task";
      return route.fulfill({ status: 201, json: [{ id: "created-task" }] });
    }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      submitted = body;
      if (!body.sourceText)
        return route.fulfill({
          status: 400,
          json: { error: { code: "BAD_REQUEST", message: "文章需要验证，无法读取正文" } },
        });
      records = [
        {
          id: "insight-demo",
          projectId: project.id,
          projectName: project.name,
          workspace: project.path,
          title: body.title,
          sourceUrl: body.sourceUrl,
          sourceText: body.sourceText,
          analysisTaskId: "analysis-task",
          analysisRunId: "analysis-run",
          status: "analyzing",
          summary: "",
          reviewedFiles: [],
          suggestions: [],
          error: null,
          createdAt: date,
          updatedAt: date,
        },
      ];
      return route.fulfill({ status: 201, json: records[0] });
    }
    if (ready && records[0])
      records[0] = {
        ...records[0],
        status: "ready",
        summary: "可以完善现有会话整理能力。",
        reviewedFiles: ["src/chat.ts"],
        suggestions: [
          {
            id: "suggestion-demo",
            title: "为会话补充归档",
            status: "partial",
            priority: "high",
            effort: "small",
            rationale: "已发现会话列表，但归档入口需要完善。",
            proposal: "增加归档筛选并保留原始消息。",
            sourceQuote: "增加分组和归档",
            evidence: [{ path: "src/chat.ts", detail: "列表展示已有会话标题" }],
            acceptance: ["归档后可恢复原始消息"],
            taskId: records[0].suggestions[0]?.taskId ?? null,
          },
        ],
      };
    return route.fulfill({ json: records });
  });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "资料转改进", exact: true }).click();
  await page.getByRole("textbox", { name: "分析名称", exact: true }).fill("会话管理改进");
  await page
    .getByRole("textbox", { name: "资料链接", exact: true })
    .fill("https://example.com/article");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请粘贴正文后重试");
  await page.getByRole("textbox", { name: "资料正文", exact: true }).fill(sourceText);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("正在对照项目代码与资料");
  expect(submitted).toMatchObject({ projectId: project.id, sourceText });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  ready = true;
  await page.reload();
  await page.getByRole("button", { name: "资料转改进", exact: true }).click();
  await page
    .getByRole("complementary", { name: "资料分析历史" })
    .getByRole("button", { name: /会话管理改进/ })
    .click();
  await expect(page.getByText("可以完善现有会话整理能力。", { exact: true })).toBeVisible();
  await expect(page.getByText("本次检查了 1 个文件片段", { exact: true })).toBeVisible();
  await expect(page.getByText("归档后可恢复原始消息", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://example.com/article" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建并运行所选任务（0）" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "为会话补充归档" }).check();
  await page.getByRole("button", { name: "创建并运行所选任务（1）" }).click();
  await expect(page.getByRole("link", { name: "已创建任务 · 查看执行 →" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "为会话补充归档" })).toBeDisabled();
  expect(selected).toEqual(["suggestion-demo"]);
  await page.screenshot({
    path: resolve("../../.workflow/.scratchpad/session-workbench/project-insights.png"),
    fullPage: true,
  });
});

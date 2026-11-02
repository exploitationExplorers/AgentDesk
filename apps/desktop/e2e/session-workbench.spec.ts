import { expect, test, type Page } from "@playwright/test";
import type { Artifact, ChatMessage, ContextSummary, SessionWorkbench } from "@agentdesk/shared";

const date = "2026-11-02T08:00:00.000Z";
const summary: ContextSummary = {
  goal: "完善项目会话管理",
  constraints: ["保留旧会话兼容性"],
  decisions: ["使用分组整理会话"],
  facts: ["项目使用 React 和 TypeScript"],
  pending: ["补充归档恢复验收"],
};
const artifact: Artifact = {
  id: "session-report",
  taskId: "session-task",
  runId: "session-run",
  kind: "summary",
  version: 1,
  title: "会话改进报告",
  content: "# 会话改进报告\n\n已核对分组与归档行为。",
  filePath: null,
  mimeType: "text/markdown",
  metadata: null,
  artifactKey: "session-report",
  createdAt: date,
};

async function fixture(page: Page, hasSummary = false) {
  const conversation = {
    id: "session-demo",
    title: "会话状态演示",
    createdAt: date,
    updatedAt: date,
  };
  const state: SessionWorkbench = {
    conversation,
    workspace: "D:/projects/session-demo",
    task: {
      id: "session-task",
      title: "完善会话整理",
      goal: "保留上下文并完善会话整理",
      agent: "code",
      conversationId: conversation.id,
      requiresPlanApproval: false,
      status: "awaiting_review",
      currentRunId: "session-run",
      pendingApprovalId: null,
      createdAt: date,
      updatedAt: date,
      closedAt: null,
    },
    runs: [
      {
        id: "session-run",
        taskId: "session-task",
        parentRunId: null,
        kind: "root",
        agent: "code",
        status: "succeeded",
        trigger: "create",
        idempotencyKey: null,
        input: { userMessage: "完善会话整理", workspace: "D:/projects/session-demo" },
        resultText: "已完成检查",
        resultError: null,
        toolCalls: [],
        cancelRequested: false,
        cancelRequestedAt: null,
        startedAt: date,
        endedAt: date,
        createdAt: date,
      },
    ],
    artifacts: [artifact],
    usedTools: ["fs.read", "shell.run"],
    pendingApprovals: 0,
    activity: null,
    context: {
      conversationId: conversation.id,
      providerId: "provider-demo",
      model: "gpt-5.2",
      contextWindow: 128000,
      capacitySource: "configured",
      inputBudgetTokens: 100000,
      estimatedInputTokens: 42000,
      historyTokens: 38000,
      systemTokens: 4000,
      summaryTokens: hasSummary ? 1200 : 0,
      estimated: true,
      messageCount: 12,
      retainedMessages: hasSummary ? 6 : 12,
      summarizedMessages: hasSummary ? 6 : 0,
      summary: hasSummary ? summary : null,
      updatedAt: hasSummary ? date : null,
    },
    contextError: null,
    latestUsage: {
      type: "model_usage",
      agent: "code",
      providerId: "provider-demo",
      model: "gpt-5.2",
      purpose: "response",
      inputTokens: 12345,
      outputTokens: 678,
      cacheReadTokens: 900,
      cacheWriteTokens: 40,
      totalTokens: 13963,
      contextWindow: 128000,
      estimatedInputTokens: 42000,
    },
    lastCompaction: null,
  };
  const history: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `history-${index}`,
    conversationId: conversation.id,
    role: index % 2 === 0 ? "user" : "assistant",
    content:
      index === 0
        ? "最早一轮：请保留旧会话兼容性。"
        : index === 11
          ? "最后一轮：继续验证归档恢复。"
          : `历史消息 ${index + 1}`,
    agent: index % 2 === 0 ? null : "code",
    toolCalls: [],
    createdAt: date,
  }));
  let compactRequests = 0;
  let chatRequests = 0;
  let release!: (failed: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() =>
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000)),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/conversations") return route.fulfill({ json: [conversation] });
    if (["/api/conversation-groups", "/api/projects", "/api/approvals"].includes(path))
      return route.fulfill({ json: [] });
    if (path === `/api/conversations/${conversation.id}/messages`)
      return route.fulfill({ json: history });
    if (path === `/api/conversations/${conversation.id}/workbench`)
      return route.fulfill({ json: state });
    if (path === `/api/conversations/${conversation.id}/compact`) {
      compactRequests += 1;
      state.activity = "compacting";
      const failed = await completion;
      state.activity = null;
      if (failed) {
        state.lastCompaction = {
          type: "context_compaction",
          phase: "error",
          conversationId: conversation.id,
          message: "压缩失败，仍使用上次摘要。",
        };
        return route.fulfill({
          status: 503,
          json: {
            error: { code: "PROVIDER_UNAVAILABLE", message: "模型暂时不可用，原始消息未更改" },
          },
        });
      }
      state.context = {
        ...state.context!,
        estimatedInputTokens: 8000,
        historyTokens: 2800,
        summaryTokens: 1200,
        summarizedMessages: 6,
        retainedMessages: 6,
        summary,
        updatedAt: date,
      };
      state.lastCompaction = {
        type: "context_compaction",
        phase: "complete",
        conversationId: conversation.id,
        message: "较早的 6 条消息已整理为摘要。",
      };
      return route.fulfill({ json: state.context });
    }
    if (path === "/api/chat") {
      chatRequests += 1;
      return route.fulfill({
        status: 409,
        json: { error: { code: "CONFLICT", message: "测试不应发送聊天请求" } },
      });
    }
    if (path === "/api/tasks/session-task/artifacts") return route.fulfill({ json: [artifact] });
    if (path === "/api/tasks/session-task/artifacts/session-report/content")
      return route.fulfill({
        json: {
          artifact,
          content: artifact.content,
          mimeType: artifact.mimeType,
          encoding: "utf8",
          source: "snapshot",
          editable: true,
          changedOnDisk: false,
        },
      });
    return route.continue();
  });
  await page.goto(`/#/?c=${conversation.id}`);
  const panel = page.getByRole("complementary", { name: "会话状态" });
  await expect(panel.getByRole("heading", { name: "上下文预算" })).toBeVisible();
  return {
    panel,
    state,
    history,
    composer: page.getByPlaceholder(
      "问我任何事：部署 IM 项目、今天 GitHub 有什么新东西、哪些项目还没提交…",
    ),
    finish: (failed = false) => release(failed),
    get compactRequests() {
      return compactRequests;
    },
    get chatRequests() {
      return chatRequests;
    },
  };
}

test("侧栏区分预算估算和真实用量，并从当前任务打开成果", async ({ page }) => {
  const { panel } = await fixture(page);
  await expect(panel.getByText("D:/projects/session-demo", { exact: true })).toBeVisible();
  await expect(panel.getByText("窗口 128,000 tokens · 已配置", { exact: true })).toBeVisible();
  await expect(panel.getByText("估算 42,000 / 100,000 tokens", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "上下文预算占用" })).toHaveAttribute(
    "value",
    "42000",
  );
  await expect(panel.getByRole("progressbar", { name: "上下文预算占用" })).toHaveAttribute(
    "max",
    "100000",
  );
  await expect(panel.getByText("输入 12,345 · 输出 678", { exact: true })).toBeVisible();
  await expect(panel.getByText("缓存读取 900 · 写入 40", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("模型实际返回的用量，非整段会话累计。", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("fs.read、shell.run", { exact: true })).toBeVisible();
  await expect(panel.getByText("1 / 1 次运行完成 · 0 项待审批", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "查看成果（1）" }).click();
  const dialog = page.getByRole("dialog", { name: "会话成果" });
  await expect(dialog.getByRole("region", { name: "成果工作区" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "会话改进报告" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "下载成果" })).toHaveAttribute(
    "href",
    /\/tasks\/session-task\/artifacts\/session-report\/download/,
  );
});

test("手动压缩期间禁止发送和重复提交，隐藏侧栏仍保留禁用状态，完成可查看摘要", async ({ page }) => {
  const view = await fixture(page);
  await view.composer.fill("保留这条尚未发送的草稿");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await view.panel.getByRole("button", { name: "压缩较早内容", exact: true }).click();
  await expect.poll(() => view.compactRequests).toBe(1);
  await expect(view.composer).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  const compact = view.panel.getByRole("button", { name: "正在压缩…", exact: true });
  await expect(compact).toBeDisabled();
  // 原生按钮点击也遵守 disabled，不产生第二个压缩请求。
  await compact.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await page
    .getByRole("button", { name: "发送", exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  expect(view.compactRequests).toBe(1);
  expect(view.chatRequests).toBe(0);
  await page.getByRole("button", { name: "会话状态", exact: true }).click();
  await expect(view.panel).toHaveCount(0);
  await expect(view.composer).toBeDisabled();
  view.finish();
  await expect(view.composer).toBeEnabled();
  await expect(view.composer).toHaveValue("保留这条尚未发送的草稿");
  await page.getByRole("button", { name: "会话状态", exact: true }).click();
  await expect(view.panel.getByText("估算 8,000 / 100,000 tokens", { exact: true })).toBeVisible();
  await view.panel.getByText("查看会话摘要", { exact: true }).click();
  for (const text of [
    summary.goal,
    ...summary.constraints,
    ...summary.decisions,
    ...summary.facts,
    ...summary.pending,
  ])
    await expect(view.panel.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText("最早一轮：请保留旧会话兼容性。", { exact: true })).toBeVisible();
  await expect(page.getByText("最后一轮：继续验证归档恢复。", { exact: true })).toBeVisible();
  expect(view.compactRequests).toBe(1);
  expect(view.chatRequests).toBe(0);
});

test("压缩失败显示错误，保留原始历史和已有摘要并允许再次操作", async ({ page }) => {
  const view = await fixture(page, true);
  await view.panel.getByText("查看会话摘要", { exact: true }).click();
  await expect(view.panel.getByText(summary.goal, { exact: true })).toBeVisible();
  await view.panel.getByRole("button", { name: "压缩较早内容", exact: true }).click();
  await expect(view.composer).toBeDisabled();
  view.finish(true);
  await expect(view.panel.getByRole("alert")).toHaveText("模型暂时不可用，原始消息未更改");
  await expect(view.composer).toBeEnabled();
  await expect(view.panel.getByRole("button", { name: "压缩较早内容", exact: true })).toBeEnabled();
  await expect(view.panel.getByText(summary.goal, { exact: true })).toBeVisible();
  await expect(view.panel.getByText("估算 42,000 / 100,000 tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("最早一轮：请保留旧会话兼容性。", { exact: true })).toBeVisible();
  await expect(page.getByText("最后一轮：继续验证归档恢复。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(view.panel.getByText("压缩失败，仍使用上次摘要。", { exact: true })).toBeVisible();
  await view.panel.getByText("查看会话摘要", { exact: true }).click();
  await expect(view.panel.getByText(summary.goal, { exact: true })).toBeVisible();
  await expect(page.getByText("最早一轮：请保留旧会话兼容性。", { exact: true })).toBeVisible();
  expect(view.history).toHaveLength(12);
  expect(view.compactRequests).toBe(1);
  expect(view.chatRequests).toBe(0);
});

import { expect, test } from "@playwright/test";

test("追问卡片直接提交选项且不会出现全局审批浮窗", async ({ page }, testInfo) => {
  let pending = true;
  let answer = "";
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-question/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "demo-question", title: "知识库实施规划" },
          task: { pendingApprovalId: null, purpose: "general" },
          activity: "running",
          runs: [],
          artifacts: [],
          usedTools: [],
          pendingApprovals: 1,
          pendingApprovalIds: ["question-1"],
          context: null,
          contextError: null,
          latestUsage: null,
          lastCompaction: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-question/messages"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) =>
      route.fulfill({
        json: pending
          ? [
              {
                id: "question-1",
                conversationId: "demo-question",
                kind: "question",
                title: "需要你补充信息",
                detail: "项目预算范围？",
                risk: "confirm",
                payload: {
                  kind: "question",
                  options: ["50 万以内", "50-150 万"],
                  index: 1,
                  total: 2,
                },
                status: "pending",
                createdAt: new Date().toISOString(),
                resolvedAt: null,
              },
            ]
          : [],
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals/question-1/answer"),
    async (route) => {
      answer = (route.request().postDataJSON() as { text: string }).text;
      pending = false;
      await route.fulfill({ json: { id: "question-1", kind: "question", status: "approved" } });
    },
  );

  await page.goto("/");
  await expect(page.getByRole("region", { name: "待回答的问题" })).toHaveCount(0);
  await page.getByRole("link", { name: "查看等待回复的对话" }).click();
  await expect(page).toHaveURL(/c=demo-question/);
  const question = page.getByRole("region", { name: "待回答的问题" });
  await expect(question).toBeVisible();
  await expect(question.getByText("1 / 2")).toBeVisible();
  await page.reload();
  await expect(question).toBeVisible();
  await expect(page.getByText("批准执行")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("chat-question-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(question).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("chat-question-mobile.png") });
  await page.getByRole("button", { name: "打开主导航" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.getByRole("button", { name: "关闭主导航" }).click({ position: { x: 350, y: 400 } });
  await question.getByRole("button", { name: "50-150 万" }).click();
  await expect.poll(() => answer).toBe("50-150 万");
  await expect(question).toHaveCount(0);
  pending = true;
  await page.reload();
  await question.getByRole("button", { name: "关闭" }).click();
  await expect.poll(() => answer).toBe("跳过");
});

test("本机操作只显示任务选择，不把命令暴露在对话", async ({ page }, testInfo) => {
  const command = "python -c \"print('environment check')\"";
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-command/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "demo-command", title: "制作演示文稿" },
          task: { pendingApprovalId: "shell-1", purpose: "general" },
          activity: "running",
          runs: [],
          artifacts: [],
          usedTools: [],
          pendingApprovals: 1,
          context: null,
          contextError: null,
          latestUsage: null,
          lastCompaction: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-command/messages"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) =>
      route.fulfill({
        json: [
          {
            id: "shell-1",
            kind: "tool",
            title: `执行命令：${command}`,
            detail: "工作目录：(默认)",
            risk: "dangerous",
            payload: { tool: "shell.run", args: { command, purpose: "检查演示文稿生成环境" } },
            status: "pending",
            createdAt: new Date().toISOString(),
            resolvedAt: null,
          },
        ],
      }),
  );

  await page.goto("/#/?c=demo-command");
  await expect(page.getByRole("region", { name: "确认下一步" })).toBeVisible();
  await expect(page.getByText("检查演示文稿生成环境")).toBeVisible();
  await expect(page.getByText(command, { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("chat-approval-desktop.png") });
  await expect(page.getByText("查看命令与工作目录")).toHaveCount(0);
});

test("已处理的本机操作不留技术审批卡片", async ({ page }) => {
  const command = "node -e \"require('sharp')\"";
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/api/chat")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const emit = (event: unknown) =>
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            emit({ type: "conversation", conversationId: "demo-resolved" });
            emit({ type: "agent_start", agent: "orchestrator" });
            emit({
              type: "tool_call",
              agent: "orchestrator",
              id: "shell",
              name: "shell.run",
              args: { command: "node -e \"require('sharp')\"" },
            });
            emit({
              type: "approval_required",
              approvalId: "already-approved",
              title: "执行命令：node -e require('sharp')",
              detail: "内部工作目录：D:/private",
              payload: { tool: "shell.run" },
            });
            emit({
              type: "tool_result",
              agent: "orchestrator",
              id: "shell",
              result: "private diagnostic output",
              isError: false,
            });
            emit({ type: "text_delta", agent: "orchestrator", delta: "正在整理演示文稿内容" });
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return fetch(input, init);
    };
  });
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-resolved/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "demo-resolved", title: "PPT 制作" },
          task: null,
          activity: null,
          runs: [],
          artifacts: [],
          usedTools: [],
          pendingApprovals: 0,
          pendingApprovalIds: [],
          context: null,
          contextError: null,
          latestUsage: null,
          lastCompaction: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/demo-resolved/messages"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto("/#/?c=demo-resolved");
  await page.getByRole("textbox").last().fill("继续制作 PPT");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("正在整理演示文稿内容")).toBeVisible();
  await expect(page.getByRole("region", { name: "确认下一步" })).toHaveCount(0);
  await expect(page.getByText(command, { exact: false })).toHaveCount(0);
  await expect(page.getByText("D:/private", { exact: false })).toHaveCount(0);
  await expect(page.getByText("private diagnostic output", { exact: false })).toHaveCount(0);
});

test("主题切换在全局生效", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: false }, version: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("html.dark")).toHaveCount(0);
  await page.getByRole("button", { name: "切换主题" }).first().click();
  await expect(page.locator("html.dark")).toHaveCount(1);
});

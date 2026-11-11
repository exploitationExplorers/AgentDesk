import { expect, test } from "@playwright/test";
import type { RunEventRecord, TaskStreamEvent } from "@agentdesk/shared";
import { resolve } from "node:path";
import { responses } from "../scripts/readme-fixtures";

test("编码现场增量展示读取、文件差异和命令输出，刷新可回放", async ({ page }) => {
  let stage = 0;
  const task = {
    id: "coding-demo",
    title: "修复登录状态恢复，并补充验证",
    goal: "检查 src/auth/session.ts，修复刷新后登录状态丢失的问题，保留已有会话并运行相关测试。",
    agent: "code",
    conversationId: "coding-conversation",
    requiresPlanApproval: false,
    status: "running",
    currentRunId: "run-demo",
    pendingApprovalId: null,
    createdAt: "2026-10-28T09:40:00Z",
    updatedAt: "2026-10-28T09:40:00Z",
    closedAt: null,
  };
  const event = (seq: number, data: TaskStreamEvent): RunEventRecord => ({
    seq,
    taskId: task.id,
    runId: "run-demo",
    parentRunId: null,
    createdAt: `2026-10-28T09:40:${String(seq).padStart(2, "0")}Z`,
    event: data,
  });
  const records = [
    event(1, {
      type: "run_started",
      runId: "run-demo",
      parentRunId: null,
      agent: "code",
      trigger: "create",
    }),
    event(2, {
      type: "tool_call",
      id: "read",
      agent: "code",
      name: "fs.read",
      args: { path: "src/auth/session.ts" },
    }),
    event(3, {
      type: "tool_result",
      id: "read",
      agent: "code",
      result: { content: "export function restoreSession() {\n  return null;\n}\n" },
      isError: false,
    }),
    event(4, {
      type: "tool_call",
      id: "patch",
      agent: "code",
      name: "fs.patch",
      args: {
        path: "src/auth/session.ts",
        oldText: "return null;",
        newText:
          'const saved = sessionStorage.getItem("session");\n  return saved ? JSON.parse(saved) : null;',
      },
    }),
    event(5, {
      type: "file_change",
      agent: "code",
      toolCallId: "patch",
      change: {
        path: "D:/projects/portal/src/auth/session.ts",
        operation: "edit",
        additions: 2,
        deletions: 1,
        diff: '--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,3 +1,4 @@\n export function restoreSession() {\n-  return null;\n+  const saved = sessionStorage.getItem("session");\n+  return saved ? JSON.parse(saved) : null;\n }',
        truncated: false,
        beforeHash: "a",
        afterHash: "b",
      },
    }),
    event(6, {
      type: "tool_result",
      agent: "code",
      id: "patch",
      result: { replacements: 1 },
      isError: false,
    }),
    event(7, {
      type: "tool_call",
      agent: "code",
      id: "test",
      name: "shell.run",
      args: { command: "pnpm test -- session", cwd: "D:/projects/portal" },
    }),
    event(8, {
      type: "tool_output",
      agent: "code",
      toolCallId: "test",
      delta: "RUN v3.2.7\n✓ session.test.ts (4 tests)\nTests 4 passed (4)\n",
    }),
    event(9, {
      type: "tool_result",
      agent: "code",
      id: "test",
      result: { exitCode: 0, output: "Tests 4 passed (4)" },
      isError: false,
    }),
    event(10, {
      type: "text_delta",
      agent: "code",
      delta:
        "已修复登录状态恢复。\n\n- 刷新页面后从会话存储恢复登录信息。\n- 相关的 4 项测试全部通过。",
    }),
    event(11, { type: "run_ended", runId: "run-demo", status: "succeeded" }),
  ];
  // 编码现场现在走真 SSE（/tasks/:id/stream），不再轮询 /tasks/:id/events；
  // EventSource 原生重连会带 Last-Event-ID，retry 字段调短好让测试里的重连不用等默认的几秒。
  const sseBody = (page_: RunEventRecord[]) =>
    `retry: 30\n${page_.map((r) => `id: ${r.seq}\ndata: ${JSON.stringify(r)}\n\n`).join("")}`;
  const cursors: number[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/tasks")
      return route.fulfill({ json: [{ ...task, status: stage ? "awaiting_review" : "running" }] });
    if (path === "/api/approvals") return route.fulfill({ json: [] });
    if (path.endsWith("/tasks/coding-demo/runs"))
      return route.fulfill({
        json: [
          {
            id: "run-demo",
            taskId: task.id,
            agent: "code",
            kind: "root",
            parentRunId: null,
            trigger: "create",
            status: stage ? "succeeded" : "running",
            createdAt: task.createdAt,
          },
        ],
      });
    if (path.endsWith("/tasks/coding-demo/stream")) {
      const headers = route.request().headers();
      const after = Number(headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
      cursors.push(after);
      return route.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody(records.filter((e) => e.seq > after && (stage || e.seq <= 3))),
      });
    }
    const key = path.slice(4) as keyof typeof responses;
    return route.fulfill({ json: responses[key] ?? [] });
  });
  await page.goto("/#/code?task=coding-demo");
  await expect(page.getByRole("heading", { name: "编码" })).toBeVisible();
  await expect(page.getByText("代码改动会出现在这里")).toBeVisible();
  await expect(page.getByRole("button", { name: /读取文件.*session.ts/ })).toBeVisible();
  await page.getByRole("tab", { name: "流程图" }).click();
  // run 根卡 + fs.read 思考卡（后续 tool 步骤会继续长出卡片）
  const flowNodes = page.locator(".react-flow__node");
  await expect(flowNodes).toHaveCount(2, { timeout: 10_000 });
  await expect(flowNodes.getByText("读取文件", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "执行过程" }).click();
  stage = 1;
  await expect(page.getByTestId("code-diff")).toContainText('sessionStorage.getItem("session")');
  await expect(page.getByText("确认完成", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve("../../.workflow/.scratchpad/code-live.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /工具输出/ }).click();
  await expect(page.getByTestId("tool-output")).toContainText("Tests 4 passed");
  // 上面两个断言能看到 stage=1 之后的新内容，本身已经证明 EventSource 重连过（不是只拿到首次
  // 快照）；这里再确认确实发生了不止一次 stream 请求，不依赖浏览器重连时 Last-Event-ID 的具体取值。
  expect(cursors.length).toBeGreaterThan(1);
  await page.reload();
  await expect(page.getByTestId("code-diff")).toContainText("return saved");
  await expect(
    page
      .getByRole("region", { name: "代码检查器" })
      .getByRole("button")
      .filter({ hasText: "session.ts" }),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 980, height: 800 });
  await expect(page.getByRole("heading", { name: "编码" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("新任务表单校验项目和目标，CLI 断开时显示可恢复错误", async ({ page }) => {
  let submitted: { goal: string; agent: string; workspace: string } | undefined;
  let terminalAttempts = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/tasks") {
      if (route.request().method() === "POST") {
        submitted = route.request().postDataJSON();
        return route.fulfill({ status: 201, json: { id: "new-task" } });
      }
      return route.fulfill({ json: [] });
    }
    if (url.pathname === "/api/projects")
      return route.fulfill({
        json: [{ id: "project", name: "portal", path: "D:/projects/portal" }],
      });
    if (url.pathname.startsWith("/api/desktop-terminal")) {
      if (url.pathname.endsWith("/start")) terminalAttempts++;
      return route.fulfill({
        status: 400,
        json: {
          error: { code: "BAD_REQUEST", message: "未找到正在运行的 CLI，请先执行 pnpm cli。" },
        },
      });
    }
    const key = url.pathname.slice(4) as keyof typeof responses;
    return route.fulfill({ json: responses[key] ?? [] });
  });
  await page.goto("/#/code");
  await page.getByRole("button", { name: "开始第一项任务" }).click();
  await expect(page.getByRole("button", { name: "开始编码" })).toBeDisabled();
  await page.getByLabel("目标项目").selectOption("project");
  await page.getByLabel("任务目标").fill("修复登录状态恢复");
  await page.getByRole("button", { name: "开始编码" }).click();
  await expect.poll(() => submitted?.workspace).toBe("D:/projects/portal");
  expect(submitted?.goal).toBe("修复登录状态恢复");
  expect(submitted?.agent).toBe("code");
  await page.getByRole("button", { name: "CLI 会话", exact: true }).click();
  await expect(page.getByText("未找到正在运行的 CLI", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => terminalAttempts).toBe(2);
});

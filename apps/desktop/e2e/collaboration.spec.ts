import { expect, test, type Page } from "@playwright/test";
import type { Artifact, Run, RunEventRecord, Task, TaskStreamEvent } from "@agentdesk/shared";

async function collaborationFixture(
  page: Page,
  source: "workbench" | "cli" = "workbench",
  automation = false,
) {
  const base = Date.now() - 45_000;
  const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const task: Task = {
    id: "collaboration-task",
    title: "为 AgentDesk 构建协作工作台",
    goal: "让多个 Agent 的执行过程成为一张可追踪的协作地图。",
    agent: "orchestrator",
    conversationId: "collaboration-chat",
    requiresPlanApproval: false,
    status: "running",
    currentRunId: "root",
    pendingApprovalId: null,
    createdAt: at(-120),
    updatedAt: at(30),
    closedAt: null,
  };
  if (automation) task.automationId = "collaboration-automation";
  const makeRun = (
    id: string,
    agent: Run["agent"],
    title: string,
    start: number,
    parentRunId: string | null = "root",
    patch: Partial<Run> = {},
  ): Run => ({
    id,
    taskId: task.id,
    agent,
    parentRunId,
    kind: parentRunId ? "delegate" : "root",
    status: "running",
    trigger: parentRunId ? "delegate" : "create",
    idempotencyKey: null,
    input: { userMessage: title, workspace: "D:/projects/AgentDesk" },
    resultText: null,
    resultError: null,
    toolCalls: [],
    cancelRequested: false,
    cancelRequestedAt: null,
    startedAt: at(start),
    createdAt: at(start),
    endedAt: null,
    ...patch,
  });
  const runs = [
    makeRun("old-root", "orchestrator", "验证上一轮方案", -120, null, {
      status: "succeeded",
      endedAt: at(-90),
      resultText: "上一轮方案已验证。",
    }),
    makeRun("root", "orchestrator", task.goal, 0, null),
    makeRun("research", "research", "梳理交互与任务模型", 2, "root", {
      status: "succeeded",
      endedAt: at(16),
      resultText: "已梳理任务、成员和交付结果之间的关系。",
    }),
    makeRun("code", "code", "实现协作视图组件", 6),
    makeRun("deploy", "deploy", "验证构建与部署配置", 10, "root", {
      status: "failed",
      endedAt: at(24),
      resultError: "测试服务暂时不可用。",
    }),
    makeRun("review", "reviewer", "检查交互与边界状态", 15),
  ];
  const records: RunEventRecord[] = [];
  const add = (runId: string, seconds: number, event: TaskStreamEvent) =>
    records.push({
      seq: records.length + 1,
      taskId: task.id,
      runId,
      parentRunId: runs.find((run) => run.id === runId)?.parentRunId ?? null,
      createdAt: at(seconds),
      event,
    });
  for (const run of runs)
    add(run.id, (Date.parse(run.startedAt!) - base) / 1000, {
      type: "run_started",
      runId: run.id,
      parentRunId: run.parentRunId,
      agent: run.agent,
      trigger: run.trigger,
    });
  add("old-root", -90, { type: "run_ended", runId: "old-root", status: "succeeded" });
  add("research", 16, { type: "run_ended", runId: "research", status: "succeeded" });
  add("code", 18, {
    type: "tool_call",
    agent: "code",
    id: "write",
    name: "fs.write",
    args: { path: "src/CollaborationView.tsx" },
  });
  add("deploy", 24, {
    type: "run_ended",
    runId: "deploy",
    status: "failed",
    error: "测试服务暂时不可用。",
  });
  add("review", 25, {
    type: "approval_required",
    approvalId: "review-approval",
    title: "运行项目验证",
    detail: "pnpm test",
  });
  add("code", 26, {
    type: "file_change",
    agent: "code",
    toolCallId: "write",
    change: {
      path: "src/CollaborationView.tsx",
      operation: "create",
      additions: 1,
      deletions: 0,
      diff: "+export const collaborationReady = true;",
      truncated: false,
      beforeHash: null,
      afterHash: "ready",
    },
  });
  records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  records.forEach((record, index) => {
    record.seq = index + 1;
  });
  let awaiting = true;
  let finished = false;
  const writes: string[] = [];
  const streams: number[] = [];
  const artifact: Artifact = {
    id: "model",
    taskId: task.id,
    runId: "research",
    title: "协作模型说明",
    kind: "summary",
    version: 1,
    content: "# 协作模型\n\n已确认执行关系。",
    filePath: null,
    mimeType: "text/markdown",
    metadata: null,
    createdAt: at(16),
  };
  const prefix = source === "cli" ? "/api/cli-monitor" : "/api";
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    if (path === `${prefix}/tasks`)
      return route.fulfill({
        json: [
          {
            ...task,
            status: finished && task.currentRunId === "root" ? "awaiting_review" : task.status,
          },
        ],
      });
    if (path === `${prefix}/tasks/${task.id}/runs`)
      return route.fulfill({
        json: runs.map((run) =>
          finished && ["root", "code", "review"].includes(run.id)
            ? { ...run, status: "succeeded", endedAt: at(40) }
            : run,
        ),
      });
    if (path === `${prefix}/tasks/${task.id}/stream`) {
      const url = new URL(request.url());
      const after = Number(
        request.headers()["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      streams.push(after);
      return route.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: `retry: 100\n${records
          .filter((record) => record.seq > after)
          .map((record) => `id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`)
          .join("")}`,
      });
    }
    if (path === `${prefix}/approvals`)
      return route.fulfill({
        json: awaiting
          ? [
              {
                id: "review-approval",
                agent: "reviewer",
                kind: "tool",
                title: "运行项目验证",
                detail: "pnpm test",
                payload: { taskId: task.id, tool: "shell.run", command: "pnpm test" },
                status: "pending",
                risk: "confirm",
                createdAt: at(25),
              },
            ]
          : [],
      });
    if (path === `${prefix}/approvals/review-approval`) {
      awaiting = false;
      return route.fulfill({ json: { approved: true } });
    }
    if (path === `${prefix}/tasks/${task.id}/artifacts`) return route.fulfill({ json: [artifact] });
    if (path === `${prefix}/tasks/${task.id}/artifacts/model/content`)
      return route.fulfill({
        json: {
          artifact,
          content: artifact.content,
          encoding: "utf8",
          mimeType: "text/markdown",
          editable: false,
          source: "snapshot",
          changedOnDisk: false,
        },
      });
    if (path === "/api/health") return route.fulfill({ json: { ok: true, version: "test" } });
    if (path === "/api/settings") return route.fulfill({ json: { avatar: "", theme: "dark" } });
    if (path === "/api/disk/status") return route.fulfill({ json: { status: "ok", volumes: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto(`/#/code?task=${task.id}&source=${source}`);
  await page.getByRole("button", { name: "协作视图", exact: true }).click();
  const view = page.getByTestId("collaboration-view");
  await expect(view.getByTestId("collaboration-member")).toHaveCount(4);
  return {
    view,
    writes,
    streams,
    finish: () => {
      finished = true;
      awaiting = false;
      add("code", 39, { type: "run_ended", runId: "code", status: "succeeded" });
      add("review", 40, { type: "run_ended", runId: "review", status: "succeeded" });
      add("root", 40, { type: "run_ended", runId: "root", status: "succeeded" });
    },
    followup: () => {
      task.currentRunId = "followup-root";
      task.updatedAt = at(41);
      task.status = "running";
      runs.push(makeRun("followup-root", "orchestrator", "复核新一轮执行", 41, null));
      add("followup-root", 41, {
        type: "run_started",
        runId: "followup-root",
        parentRunId: null,
        agent: "orchestrator",
        trigger: "followup",
      });
      add("followup-root", 42, {
        type: "tool_call",
        agent: "orchestrator",
        id: "followup-read",
        name: "fs.read",
        args: { path: "src/CollaborationView.tsx" },
      });
    },
  };
}

test("协作视图接收真实事件结构，暂停仅影响动效，终态停止光点", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { view, writes, finish } = await collaborationFixture(page);
  const reviewer = view.getByRole("button", { name: "查看审查的任务详情" });
  await expect(reviewer).toContainText("待确认");
  await expect(view.getByRole("button", { name: "查看部署的任务详情" })).toContainText("失败");
  await expect(view.getByText("协作模型说明", { exact: true })).toBeVisible();
  await expect(view.locator(".ad-collab-packet").first()).toBeVisible();
  await page.getByRole("button", { name: "批准执行", exact: true }).click();
  await expect(reviewer).toContainText("执行中");
  await view.getByRole("button", { name: "暂停动效" }).click();
  await expect(view.locator(".ad-collab-packet").first()).toHaveCSS(
    "animation-play-state",
    "paused",
  );
  finish();
  await expect(view.locator(".ad-collab-hub-title")).toContainText("已完成");
  await expect(view.locator(".ad-collab-packet")).toHaveCount(0);
  await expect(view.locator(".ad-collab-metrics")).toContainText("3 / 4 完成");
  expect(writes).toEqual(["/api/approvals/review-approval"]);
  expect(errors).toEqual([]);
});

test("历史轮次、任务详情和成果检查器互通，窄屏与减少动效可用", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1280 });
  const { view } = await collaborationFixture(page);
  await page.getByRole("button", { name: "批准执行", exact: true }).click();
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await view.screenshot({ path: testInfo.outputPath("collaboration-dark.png") });
  await view.getByRole("button", { name: "查看部署的任务详情" }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("测试服务暂时不可用");
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await view.getByRole("combobox", { name: "执行轮次" }).selectOption("old-root");
  await expect(view.getByTestId("collaboration-member")).toHaveCount(0);
  await expect(view.getByText("本轮由主控直接执行")).toBeVisible();
  await expect(view.getByText("协作模型说明", { exact: true })).toHaveCount(0);
  await view.getByRole("combobox", { name: "执行轮次" }).selectOption("root");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(view.locator(".ad-collab-packet").first()).toBeHidden();
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await view.screenshot({ path: testInfo.outputPath("collaboration-light.png") });
  await page.setViewportSize({ width: 980, height: 800 });
  await expect(view.getByTestId("collaboration-member")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await view.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("collaboration-narrow.png") });
  const timeline = view.getByRole("region", { name: "协作执行时间轴" });
  await timeline.scrollIntoViewIfNeeded();
  await expect(timeline).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("collaboration-narrow-timeline.png") });
  await view.getByRole("button", { name: "CollaborationView.tsx", exact: true }).click();
  await expect(page.getByTestId("code-diff")).toContainText("collaborationReady");
  await page.getByRole("button", { name: "协作视图", exact: true }).click();
  await view.getByRole("button", { name: "查看任务全部成果" }).click();
  await expect(page.getByRole("region", { name: "代码检查器" })).toContainText("协作模型说明");
});

test("同一任务进入新轮次后重新订阅，历史终态不会截断新事件", async ({ page }) => {
  const { view, streams, finish, followup } = await collaborationFixture(page);
  finish();
  await expect(view.locator(".ad-collab-hub-title")).toContainText("已完成");
  const previousSubscriptions = streams.filter((after) => after === 0).length;
  followup();
  await expect(view.getByRole("combobox", { name: "执行轮次" })).toHaveValue("followup-root");
  await expect(view.getByText("本轮由主控直接执行")).toBeVisible();
  await view.getByRole("button", { name: "查看主控任务详情" }).click();
  await expect(page.getByRole("dialog")).toContainText("1 次工具调用");
  expect(streams.filter((after) => after === 0).length).toBeGreaterThan(previousSubscriptions);
});

test("自动化任务在根运行结束后保持订阅", async ({ page }) => {
  const { view, streams, finish } = await collaborationFixture(page, "workbench", true);
  finish();
  await expect(view.locator(".ad-collab-hub-title")).toContainText("已完成");
  const subscriptionsAtEnd = streams.length;
  await expect.poll(() => streams.length).toBeGreaterThan(subscriptionsAtEnd);
});

test("CLI 来源的协作视图保持实例隔离", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const { view } = await collaborationFixture(page, "cli");
  await expect(view.getByText("协作模型说明", { exact: true })).toBeVisible();
  expect(requests).toContain("/api/cli-monitor/tasks/collaboration-task/artifacts");
  expect(requests).not.toContain("/api/tasks/collaboration-task/artifacts");
});

import { expect, test } from "@playwright/test";
import type {
  AutomationBinding,
  AutomationBindingInput,
  AutomationCard,
  AutoloopInteractionAnswer,
  Task,
} from "@agentdesk/shared";

const now = new Date().toISOString();
const binding: AutomationBinding = {
  id: "weekly",
  automationId: "weekly",
  hubId: "local",
  ruleName: "weekly",
  title: "每周项目汇报",
  goal: "整理项目资料并生成汇报 PPT",
  workspacePolicy: { root: "D:\\项目 空格\\报告", allowSubdirectories: true },
  enabled: true,
  maxRounds: 20,
  maxMinutes: 30,
  schedule: null,
  createdAt: now,
  updatedAt: now,
};
const task: Task = {
  id: "automation-task",
  title: binding.title,
  goal: binding.goal,
  agent: "orchestrator",
  conversationId: "automation-chat",
  requiresPlanApproval: false,
  status: "running",
  currentRunId: "first-run",
  pendingApprovalId: null,
  automationId: binding.id,
  automationStatus: "waiting_input",
  createdAt: now,
  updatedAt: now,
  closedAt: null,
};

test("创建和触发自动化使用真实交互入口，失败重发保留幂等事件 ID", async ({ page }) => {
  const bindings: AutomationBinding[] = [];
  const attempts: string[] = [];
  await page.route("**/api/autoloop/status", (route) =>
    route.fulfill({
      json: {
        available: true,
        mode: "local",
        protocolVersion: "1",
        connections: [],
        lastSyncedAt: now,
      },
    }),
  );
  await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/automations", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON() as AutomationBindingInput;
      expect(input).toMatchObject({
        title: binding.title,
        goal: binding.goal,
        workspacePolicy: binding.workspacePolicy,
        schedule: { cron: "30 9 * * *", timezone: "Asia/Shanghai" },
        maxTokens: 50000,
        maxCostUsd: 2.5,
      });
      expect(input).not.toHaveProperty("token");
      const created = { ...binding, ...input };
      bindings.push(created);
      await route.fulfill({ status: 201, json: created });
    } else await route.fulfill({ json: bindings });
  });
  await page.route("**/api/automations/weekly/trigger", async (route) => {
    const input = route.request().postDataJSON() as { eventId: string };
    attempts.push(input.eventId);
    await route.fulfill(
      attempts.length === 1
        ? {
            status: 502,
            json: { error: { code: "INTEGRATION_FAILED", message: "服务暂时不可用，请重试" } },
          }
        : { status: 202, json: { commandId: "command-1", taskId: task.id } },
    );
  });
  await page.route("**/api/automations/weekly/tasks", (route) => route.fulfill({ json: [task] }));
  await page.goto("/#/automations");
  await page.getByRole("button", { name: "新建自动化", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill(binding.title);
  await page.getByLabel("任务目标", { exact: true }).fill(binding.goal);
  await page.getByLabel("工作目录", { exact: true }).fill(binding.workspacePolicy.root);
  await page.getByLabel("每天定时执行").check();
  await page.getByLabel("时间", { exact: true }).fill("09:30");
  await page.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await page.getByText("执行限额", { exact: true }).click();
  await page.getByLabel("最多 Token（可选）").fill("50000");
  await page.getByLabel("最多费用（USD，可选）").fill("2.5");
  await page.getByRole("button", { name: "创建自动化", exact: true }).click();
  await expect(page.getByRole("heading", { name: binding.title })).toBeVisible();
  await expect(page.getByText(/每天 09:30 自动执行/)).toBeVisible();
  await page.getByRole("button", { name: "立即运行" }).click();
  await expect(page.getByRole("alert")).toContainText("请重试");
  await page.reload();
  await page.getByRole("button", { name: "立即运行" }).click();
  await expect(page.getByRole("link", { name: "查看会话与成果" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
});

test("收起运行记录时仍自动显示定时执行进度和成果，不发送手动触发请求", async ({ page }) => {
  let current: Task[] = [];
  const triggers: string[] = [];
  await page.route("**/api/automations", (route) =>
    route.fulfill({
      json: [{ ...binding, schedule: { cron: "0 16 * * *", timezone: "Asia/Shanghai" } }],
    }),
  );
  await page.route("**/api/automations/weekly/tasks", (route) => route.fulfill({ json: current }));
  await page.route("**/api/automations/weekly/trigger", (route) => {
    triggers.push(route.request().url());
    return route.abort();
  });
  await page.goto("/#/automations");
  await expect(page.getByText("等待计划时间自动执行", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "运行记录" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  current = [{ ...task, automationStatus: "running" }];
  await expect(page.getByRole("status").filter({ hasText: "最近运行" })).toContainText("正在处理");
  current = [{ ...task, status: "completed", automationStatus: "completed" }];
  await expect(page.getByRole("status").filter({ hasText: "最近运行" })).toContainText("已完成");
  await expect(page.getByRole("link", { name: "查看最新进度与成果" })).toHaveAttribute(
    "href",
    /#\/\?c=automation-chat/,
  );
  expect(triggers).toHaveLength(0);
});

test("等待问题跨刷新保留预览，显式回答只提交一次并继续原任务", async ({ page }, testInfo) => {
  let currentTask = { ...task };
  let card: AutomationCard = {
    id: "focus",
    remoteCardId: "remote-focus",
    bindingId: binding.id,
    hubId: "local",
    version: 1,
    kind: "ask",
    interactionKind: "input",
    state: "open",
    taskId: task.id,
    title: "这份汇报更侧重哪一部分？",
    description: "资料已经整理好，选择后继续制作。",
    options: ["项目进展", "风险与计划"],
    answerId: null,
    answerText: null,
    createdAt: now,
    updatedAt: now,
  };
  const answers: AutoloopInteractionAnswer[] = [];
  await page.route("**/api/conversations/automation-chat/workbench*", (route) =>
    route.fulfill({
      json: {
        conversation: { id: task.conversationId, title: task.title },
        task: currentTask,
        activity: currentTask.automationStatus === "running" ? "running" : null,
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
  await page.route("**/api/conversations/automation-chat/messages", (route) =>
    route.fulfill({
      json: [
        {
          id: "m",
          role: "assistant",
          content: "已整理资料，等待确认汇报重点。",
          agent: "orchestrator",
          toolCalls: [],
          createdAt: now,
        },
      ],
    }),
  );
  await page.route("**/api/interactions?taskId=automation-task", (route) =>
    route.fulfill({ json: [card] }),
  );
  await page.route("**/api/interactions/focus/answer", async (route) => {
    const answer = route.request().postDataJSON() as AutoloopInteractionAnswer;
    answers.push(answer);
    if (answers.length === 1) {
      await route.fulfill({
        status: 502,
        json: { error: { code: "INTEGRATION_FAILED", message: "回答暂未确认，请重试" } },
      });
      return;
    }
    card = {
      ...card,
      state: "answered",
      answerId: answer.answerId,
      answerText: card.options[answer.choice ?? 0] ?? null,
    };
    currentTask = { ...task, currentRunId: "second-run", automationStatus: "running" };
    await route.fulfill({ json: card });
  });
  await page.addInitScript(
    ({ taskId }) => {
      window.EventSource = new Proxy(window.EventSource, {
        construct(target, args) {
          if (!String(args[0]).includes(`/tasks/${taskId}/stream`))
            return Reflect.construct(target, args);
          const source = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            onerror: null,
            close: () => {},
          };
          queueMicrotask(() => {
            const records = [
              {
                seq: 1,
                taskId,
                runId: "first-run",
                parentRunId: null,
                event: {
                  type: "presentation_slide",
                  agent: "orchestrator",
                  presentationId: "report",
                  deckTitle: "项目汇报",
                  index: 1,
                  total: 2,
                  title: "已整理的项目进展",
                  svg: '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="25">项目进展</text></svg>',
                },
              },
              {
                seq: 2,
                taskId,
                runId: "first-run",
                parentRunId: null,
                event: { type: "run_ended", runId: "first-run", status: "succeeded" },
              },
            ];
            records.forEach((record) =>
              source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(record) })),
            );
          });
          return source;
        },
      });
    },
    { taskId: task.id },
  );
  await page.goto("/#/?c=automation-chat");
  const question = page.getByRole("region", { name: "自动化待回答的问题" });
  await expect(question).toBeVisible();
  await expect(page.getByRole("complementary", { name: "生成中的演示文稿" })).toBeVisible();
  await expect(question.getByRole("button", { name: "提交并继续" })).toBeDisabled();
  await expect(page.getByText("思考中…", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(question).toBeVisible();
  await expect(page.getByRole("button", { name: "第 1 页：已整理的项目进展" })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("automation-waiting.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭成果预览" }).click();
  await expect(question).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("automation-waiting-mobile.png") });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.getByRole("button", { name: "查看成果" }).click();
  await question.getByRole("button", { name: "项目进展", exact: true }).click();
  expect(answers).toHaveLength(0);
  await question.getByRole("button", { name: "提交并继续" }).click();
  await expect(question.getByRole("alert")).toContainText("请重试");
  await page.reload();
  await expect(question.getByRole("button", { name: "项目进展", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await question.getByRole("button", { name: "提交并继续" }).click();
  await expect(page.getByText("已回答：项目进展", { exact: true })).toBeVisible();
  expect(answers).toHaveLength(2);
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0]).toMatchObject({ cardVersion: 1, choice: 0 });
  expect(answers[0]?.answerId).toBeTruthy();
  await expect(page.getByRole("button", { name: "第 1 页：已整理的项目进展" })).toHaveCount(1);
});

test("检查恢复展示核实提示，完成后的修改重试保持原会话和请求 ID", async ({ page }) => {
  let currentTask: Task = { ...task, automationStatus: "needs_attention" };
  let checks = 0;
  const followups: Array<{ message: string; eventId: string }> = [];
  await page.route("**/api/conversations/automation-chat/workbench*", (route) =>
    route.fulfill({
      json: {
        conversation: { id: task.conversationId, title: task.title },
        task: currentTask,
        activity: currentTask.automationStatus === "running" ? "running" : null,
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
  await page.route("**/api/conversations/automation-chat/messages", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/interactions?taskId=automation-task", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/automation-tasks/automation-task/resume", async (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    checks++;
    if (checks === 1) {
      await route.fulfill({
        status: 409,
        json: { error: { code: "CONFLICT", message: "执行结果未知，请先核实已生成文件" } },
      });
    } else {
      currentTask = { ...task, automationStatus: "completed" };
      await route.fulfill({ json: { requested: true } });
    }
  });
  await page.route("**/api/automation-tasks/automation-task/followup", async (route) => {
    followups.push(route.request().postDataJSON() as { message: string; eventId: string });
    if (followups.length === 1) {
      await route.fulfill({
        status: 502,
        json: { error: { code: "INTEGRATION_FAILED", message: "提交暂未确认，请重试" } },
      });
    } else {
      currentTask = { ...task, currentRunId: "followup-run", automationStatus: "running" };
      await route.fulfill({ status: 202, json: { commandId: "followup-command" } });
    }
  });
  await page.goto("/#/?c=automation-chat");
  await page.getByRole("button", { name: "检查并恢复", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先核实");
  await expect(page.getByRole("button", { name: "检查并恢复", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检查并恢复", exact: true }).click();
  await page
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("把最后一页补上下一步计划");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请重试");
  await page.reload();
  await page.getByRole("button", { name: "重试上次修改请求", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止任务及后续触发", exact: true })).toBeVisible();
  expect(followups).toHaveLength(2);
  expect(followups[0]).toEqual(followups[1]);
  expect(followups[0]?.message).toBe("把最后一页补上下一步计划");
  await expect(page).toHaveURL(/c=automation-chat/);
});

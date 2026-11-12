import { expect, test, type Page } from "@playwright/test";
import { responses } from "../scripts/readme-fixtures";

async function fixture(page: Page, historyCount = 18) {
  const date = "2026-11-02T08:00:00.000Z";
  const conversation = {
    id: "motion-chat",
    title: "一起完善 Agent 工作台",
    createdAt: date,
    updatedAt: date,
  };
  const history = Array.from({ length: historyCount }, (_, i) => ({
    id: `message-${i}`,
    conversationId: conversation.id,
    role: i % 2 ? "assistant" : "user",
    content:
      i % 2
        ? `### 第 ${i} 次进展\n\n已检查项目结构与交互流程，接下来完善输入、消息阅读和执行反馈。\n\n- 保留当前任务与成果\n- 支持键盘操作\n- 允许继续阅读历史消息`
        : `帮我检查第 ${i + 1} 个工作台交互。`,
    agent: i % 2 ? "code" : null,
    toolCalls: [],
    createdAt: date,
  }));
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: true }, version: 0 }),
    );
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/api/chat")) {
        const response = await original(input, init);
        if (String(input).endsWith("/stop")) window.dispatchEvent(new Event("chat-test-end"));
        return response;
      }
      sessionStorage.setItem("chat-test-request", String(init?.body));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          emit({ type: "conversation", conversationId: "motion-chat" });
          emit({ type: "agent_start", agent: "code" });
          emit({ type: "text_delta", agent: "code", delta: "正在检查工作台。" });
          const listener = (event: Event) =>
            emit({
              type: "text_delta",
              agent: "code",
              delta: (event as CustomEvent<string>).detail,
            });
          const fail = () => {
            window.removeEventListener("chat-test-delta", listener);
            controller.error(new Error("test stream disconnected"));
          };
          window.addEventListener("chat-test-delta", listener);
          window.addEventListener("chat-test-fail", fail, { once: true });
          window.addEventListener(
            "chat-test-end",
            () => {
              window.removeEventListener("chat-test-delta", listener);
              window.removeEventListener("chat-test-fail", fail);
              emit({ type: "done" });
              controller.close();
            },
            { once: true },
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              window.removeEventListener("chat-test-delta", listener);
              window.removeEventListener("chat-test-fail", fail);
              controller.error(new DOMException("Stopped", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  let stops = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/conversations") return route.fulfill({ json: [conversation] });
    if (["/conversation-groups", "/approvals"].includes(path)) return route.fulfill({ json: [] });
    if (path === "/conversations/motion-chat/messages") return route.fulfill({ json: history });
    if (path === "/conversations/motion-chat/stop") {
      stops++;
      return route.fulfill({ json: { stopped: true } });
    }
    if (path === "/conversations/motion-chat/workbench")
      return route.fulfill({
        json: {
          conversation,
          task: null,
          activity: null,
          runs: [],
          artifacts: [],
          usedTools: ["fs.read", "fs.search"],
          pendingApprovals: 0,
          pendingApprovalIds: [],
          workspace: "D:/projects/agentdesk",
          latestUsage: null,
          contextError: null,
          lastCompaction: null,
          context: {
            conversationId: conversation.id,
            providerId: "demo-provider",
            model: "gpt-5.2",
            contextWindow: 128000,
            capacitySource: "configured",
            inputBudgetTokens: 100000,
            estimatedInputTokens: 42000,
            historyTokens: 38000,
            systemTokens: 4000,
            summaryTokens: 0,
            estimated: true,
            messageCount: history.length,
            retainedMessages: history.length,
            summarizedMessages: 0,
            summary: null,
            updatedAt: null,
          },
        },
      });
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": demo\n\n" });
    if (path in responses) return route.fulfill({ json: responses[path] });
    return route.fulfill({ json: [] });
  });
  return {
    get stops() {
      return stops;
    },
  };
}

test("Agent 菜单可用键盘选择，发送与停止连接真实交互状态", async ({ page }, testInfo) => {
  const state = await fixture(page, 2);
  await page.goto("/#/?c=motion-chat");
  await expect(page.getByRole("link", { name: "配置 Agent 模型" })).toContainText("gpt-5.2");
  const picker = page.getByRole("button", { name: "选择 Agent" });
  await picker.focus();
  await picker.press("ArrowDown");
  await page.getByRole("option", { name: /自动调度/ }).press("End");
  const code = page.getByRole("option", { name: /编码 Agent/ });
  await expect(code).toBeFocused();
  await code.press("Enter");
  await expect(picker).toBeFocused();
  await expect(picker).toContainText("编码 Agent");
  const input = page.getByRole("textbox", { name: "发送消息" });
  await input.fill("检查工作台");
  await input.press("Shift+Enter");
  await input.pressSequentially("保留现有功能");
  expect(await page.evaluate(() => sessionStorage.getItem("chat-test-request"))).toBeNull();
  await input.press("Enter");
  await expect(page.getByText("正在检查工作台。", { exact: true })).toBeVisible();
  const request = JSON.parse(
    (await page.evaluate(() => sessionStorage.getItem("chat-test-request")))!,
  );
  expect(request.agent).toBe("code");
  expect(request.message).toContain("保留现有功能");
  await expect(picker).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("chat-running-light.png") });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => state.stops).toBe(1);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(picker).toBeEnabled();
});

test("连续 150 个增量完整显示，历史消息和 GFM 表格保持正常", async ({ page }) => {
  await fixture(page, 100);
  await page.goto("/#/?c=motion-chat");
  const history = page.getByRole("heading", { name: "第 99 次进展", exact: true });
  await expect(history).toBeAttached();
  const savedHtml = await history.locator("..").evaluate((el) => el.innerHTML);
  await page.getByRole("textbox", { name: "发送消息" }).fill("验证流式输出");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("正在检查工作台。", { exact: true })).toBeVisible();
  const chunks = Array.from({ length: 150 }, (_, index) => ` ${index}:✅`);
  await page.evaluate((chunks) => {
    for (const text of chunks)
      window.dispatchEvent(new CustomEvent("chat-test-delta", { detail: text }));
  }, chunks);
  const timeline = page.getByLabel("任务进展").last();
  await expect(timeline.locator(".ad-prose")).toHaveText(`正在检查工作台。${chunks.join("")}`);
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chat-test-delta", {
        detail:
          "\n\n| 项目 | 状态 |\n| --- | --- |\n| [项目文档](https://example.com/docs) | **完成** |",
      }),
    );
  });
  await expect(timeline.getByRole("table")).toContainText("完成");
  await expect(timeline.getByRole("link", { name: "项目文档" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(timeline.getByRole("link", { name: "项目文档" })).toHaveAttribute(
    "rel",
    "noreferrer",
  );
  expect(await history.locator("..").evaluate((el) => el.innerHTML)).toBe(savedHtml);
});

test("连接异常前最后一个增量会显示并保留", async ({ page }) => {
  await fixture(page, 2);
  await page.goto("/#/?c=motion-chat");
  await page.getByRole("textbox", { name: "发送消息" }).fill("验证异常保留");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("正在检查工作台。", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("chat-test-delta", { detail: "最后一段：完整保留 🧑‍💻" }));
    // 先让 reader 收到增量，再让连接失败，避免在传输队列内直接丢弃 chunk。
    setTimeout(() => window.dispatchEvent(new Event("chat-test-fail")), 0);
  });
  await expect(page.getByLabel("任务进展").last()).toContainText("最后一段：完整保留 🧑‍💻");
  await expect(
    page.getByText("这次任务未能完成。已生成的成果会保留，你可以重试或调整要求后继续。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});

test("流式消息在底部跟随，上滑后保持阅读位置，支持回到最新", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/?c=motion-chat");
  const viewport = page.getByTestId("chat-scroll");
  const distance = () =>
    viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(distance).toBeLessThan(4);
  await page.getByRole("textbox", { name: "发送消息" }).fill("继续检查");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("正在检查工作台。", { exact: true })).toBeVisible();
  const emit = (text: string) =>
    page.evaluate(
      (text) => window.dispatchEvent(new CustomEvent("chat-test-delta", { detail: text })),
      text,
    );
  await emit("\n\n" + "新的检查结果。\n\n".repeat(10));
  await expect.poll(distance).toBeLessThan(4);
  await viewport.hover();
  await page.mouse.wheel(0, -650);
  await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
  // 等浏览器滚轮滚动结束后记录阅读位置。
  await page.waitForTimeout(300);
  const before = await viewport.evaluate((el) => el.scrollTop);
  await emit("\n\n继续生成而不打断阅读。\n\n".repeat(12));
  await expect(page.getByText(/继续生成而不打断阅读/).first()).toBeAttached();
  await expect
    .poll(() => viewport.evaluate((el, start) => Math.abs(el.scrollTop - start), before))
    .toBeLessThan(3);
  await page.getByRole("button", { name: "回到最新消息" }).click();
  await expect.poll(distance).toBeLessThan(4);
  await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
});

test("工作台宽度可调整并保存，明暗主题及窄屏均可关闭面板", async ({ page }, testInfo) => {
  await fixture(page, 4);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/?c=motion-chat");
  await page.getByRole("button", { name: "查看上下文预算，已用 42%" }).click();
  const panel = page.getByRole("complementary", { name: "会话状态" });
  const handle = page.getByRole("separator", { name: "调整工作台宽度" });
  await expect(panel).toBeVisible();
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "344");
  await page.screenshot({ path: testInfo.outputPath("chat-workbench-light.png") });
  await page.getByRole("button", { name: "关闭工作台" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "会话状态", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", "344");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 60, grip.y + grip.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "404");
  await handle.press("Escape");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await page.getByRole("switch", { name: "浅色主题" }).first().click();
  await page.screenshot({ path: testInfo.outputPath("chat-workbench-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole("button", { name: "关闭工作台" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("chat-workbench-mobile.png") });
  await page.getByRole("button", { name: "关闭工作台" }).click();
  await page.getByRole("button", { name: "选择 Agent" }).click();
  await expect(page.getByRole("listbox", { name: "选择 Agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "选择 Agent" })).toBeFocused();
});

test("欢迎页与输入菜单在桌面和窄屏下保持可读", async ({ page }, testInfo) => {
  await fixture(page, 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /今天想做什么/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-home-light.png") });
  await page.getByRole("button", { name: "选择 Agent" }).click();
  await page.screenshot({ path: testInfo.outputPath("chat-agent-menu.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "浅色主题" }).first().click();
  await page.screenshot({ path: testInfo.outputPath("chat-home-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("link", { name: "配置 Agent 模型" }).locator("svg")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-home-mobile.png") });
});

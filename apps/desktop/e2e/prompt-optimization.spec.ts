import { expect, test, type Page } from "@playwright/test";
import { responses } from "../scripts/readme-fixtures";

const original = "请检查 src/auth.ts 中的登录问题，保留 @review 和 {{token}}。";
const optimized =
  "请排查并修复 src/auth.ts 中的登录问题。保留 @review 和 {{token}}，说明原因、修改内容和验证结果，不假设错误原因。";
const date = "2026-11-11T08:00:00.000Z";

async function fixture(page: Page, configured = true, delayConversation = false) {
  const conversations = [
    { id: "optimization-one", title: "优化测试会话一", createdAt: date, updatedAt: date },
    { id: "optimization-two", title: "优化测试会话二", createdAt: date, updatedAt: date },
  ];
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: true }, version: 0 }),
    );
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.endsWith("/api/prompt-optimizations")) return fetch(input, init);
      const requests = JSON.parse(sessionStorage.getItem("optimization-requests") ?? "[]");
      requests.push(JSON.parse(String(init?.body)));
      sessionStorage.setItem("optimization-requests", JSON.stringify(requests));
      return new Promise<Response>((resolve, reject) => {
        const complete = (event: Event) => {
          cleanup();
          const detail = (event as CustomEvent<{ text: string; status?: number }>).detail;
          resolve(
            new Response(
              JSON.stringify(
                detail.status
                  ? { error: { code: "PROVIDER_UNAVAILABLE", message: detail.text } }
                  : { optimizedText: detail.text },
              ),
              { status: detail.status ?? 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        };
        const abort = () => {
          cleanup();
          sessionStorage.setItem(
            "optimization-aborted",
            String(Number(sessionStorage.getItem("optimization-aborted") ?? 0) + 1),
          );
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const cleanup = () => {
          window.removeEventListener("optimization-complete", complete);
          init?.signal?.removeEventListener("abort", abort);
        };
        window.addEventListener("optimization-complete", complete);
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    };
  });
  let chats = 0;
  let releaseChat: (() => void) | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/chat") {
      chats++;
      if (delayConversation)
        await new Promise<void>((resolve) => {
          releaseChat = resolve;
        });
      const conversationId =
        route.request().postDataJSON().conversationId ?? "optimization-created";
      return route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "conversation", conversationId })}\n\ndata: {"type":"done"}\n\n`,
      });
    }
    if (path === "/conversations") return route.fulfill({ json: conversations });
    if (path.endsWith("/messages")) return route.fulfill({ json: [] });
    if (path.endsWith("/workbench")) {
      const conversation = conversations.find((item) => path.includes(item.id)) ?? {
        id: "optimization-created",
        title: "新建会话",
        createdAt: date,
        updatedAt: date,
      };
      return route.fulfill({
        json: {
          conversation,
          task: null,
          activity: null,
          runs: [],
          artifacts: [],
          usedTools: [],
          pendingApprovals: 0,
          pendingApprovalIds: [],
          workspace: null,
          latestUsage: null,
          contextError: null,
          lastCompaction: null,
          context: null,
        },
      });
    }
    if (path === "/providers")
      return route.fulfill({
        json: configured
          ? [
              {
                id: "optimizer-provider",
                name: "测试模型",
                api: "openai-completions",
                baseUrl: "https://provider.invalid/v1",
                models: ["test-model"],
                defaultModel: "test-model",
                source: "manual",
                enabled: true,
                hasKey: true,
                createdAt: date,
              },
            ]
          : [],
      });
    if (path === "/agent-bindings")
      return route.fulfill({
        json: configured
          ? [
              {
                agent: "orchestrator",
                providerId: "optimizer-provider",
                model: "test-model",
                fallbackProviderIds: [],
              },
            ]
          : [],
      });
    if (["/conversation-groups", "/approvals", "/skills", "/projects"].includes(path))
      return route.fulfill({ json: [] });
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": mock\n\n" });
    if (path in responses) return route.fulfill({ json: responses[path] });
    return route.fulfill({ json: [] });
  });
  return {
    get chats() {
      return chats;
    },
    finishChat: () => releaseChat?.(),
  };
}

const input = (page: Page) => page.getByRole("textbox", { name: "发送消息" });
const complete = (page: Page, text = optimized, status?: number) =>
  page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("optimization-complete", { detail })),
    { text, status },
  );
const requestCount = (page: Page) =>
  page.evaluate(
    () => JSON.parse(sessionStorage.getItem("optimization-requests") ?? "[]").length as number,
  );

test("优化草稿可预览和应用，不自动发送；桌面与窄屏结果可用", async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.goto("/#/?c=optimization-one");
  await expect(page.getByRole("link", { name: "配置 Agent 模型" })).toContainText("test-model");
  await input(page).fill(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect(page.getByText("正在优化，可继续编辑草稿…")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => requestCount(page)).toBe(1);
  const requests = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("optimization-requests")!),
  );
  expect(requests[0]).toEqual({
    text: original,
    agent: "orchestrator",
    modelSelection: {
      providerId: "optimizer-provider",
      model: "test-model",
      reasoningEffort: "medium",
    },
  });
  await complete(page);
  const dialog = page.getByRole("dialog", { name: "优化提示词" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "优化后的提示词" })).toHaveValue(optimized);
  await expect(page.locator('textarea[aria-label="发送消息"]')).toHaveValue(original);
  expect(state.chats).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("prompt-optimization-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("button", { name: "应用到输入框" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("prompt-optimization-mobile.png") });
  await dialog.getByRole("button", { name: "应用到输入框" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input(page)).toHaveValue(optimized);
  await page.screenshot({ path: testInfo.outputPath("prompt-optimization-mobile-composer.png") });
  expect(state.chats).toBe(0);
  await expect(input(page)).toBeFocused();
});

test("优化时继续编辑或改回原文，旧候选无法覆盖；重试基于最新草稿", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/?c=optimization-one");
  await input(page).fill(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  await input(page).fill(`${original}\n只改一个文件。`);
  await input(page).fill(original);
  await complete(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("草稿已修改，优化结果仅供参考。")).toBeVisible();
  await page.getByRole("button", { name: "查看优化结果" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "应用到输入框" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "复制", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "重新优化" }).click();
  await expect.poll(() => requestCount(page)).toBe(2);
  await complete(page, "请检查登录问题，不改变原有接口。");
  await page.getByRole("button", { name: "应用到输入框" }).click();
  await expect(input(page)).toHaveValue("请检查登录问题，不改变原有接口。");
});

test("取消、会话切换和发送会终止优化，并保留各自草稿", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/?c=optimization-one");
  await input(page).fill(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  await page.getByRole("button", { name: "取消优化" }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("optimization-aborted")))
    .toBe("1");
  await complete(page);
  await expect(input(page)).toHaveValue(original);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(2);
  await page
    .getByRole("button", { name: /优化测试会话二/ })
    .first()
    .click();
  await expect(input(page)).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("optimization-aborted")))
    .toBe("2");
  await input(page).fill("会话二的草稿");
  await page
    .getByRole("button", { name: /优化测试会话一/ })
    .first()
    .click();
  await expect(input(page)).toHaveValue(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(3);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.chats).toBe(1);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("optimization-aborted")))
    .toBe("3");
  await expect(input(page)).toHaveValue("");
  await complete(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("新会话与历史会话草稿隔离，发送后新会话草稿清空", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/?c=optimization-one");
  await input(page).fill("历史会话的草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(input(page)).toHaveValue("");
  await input(page).fill("新会话的草稿");
  await page
    .getByRole("button", { name: /优化测试会话一/ })
    .first()
    .click();
  await expect(input(page)).toHaveValue("历史会话的草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(input(page)).toHaveValue("新会话的草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/c=optimization-created/);
  await expect(input(page)).toHaveValue("");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(input(page)).toHaveValue("");
  await page
    .getByRole("button", { name: /优化测试会话一/ })
    .first()
    .click();
  await expect(input(page)).toHaveValue("历史会话的草稿");
});

test("迟到的新会话 ID 不接管离开后重开的新草稿", async ({ page }) => {
  const state = await fixture(page, true, true);
  await page.goto("/#/");
  await input(page).fill("第一次发送的任务");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.chats).toBe(1);
  await page
    .getByRole("button", { name: /优化测试会话一/ })
    .first()
    .click();
  await expect(page).toHaveURL(/c=optimization-one/);
  await input(page).fill("历史会话草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(page).not.toHaveURL(/c=/);
  await input(page).fill("第二个全新的任务草稿");
  state.finishChat();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/c=/);
  await expect(input(page)).toHaveValue("第二个全新的任务草稿");
  await page
    .getByRole("button", { name: /优化测试会话一/ })
    .first()
    .click();
  await expect(input(page)).toHaveValue("历史会话草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(input(page)).toHaveValue("第二个全新的任务草稿");
});

test("模型缺失、长输入和请求失败都保留草稿", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/#/");
  await input(page).fill(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect(page.getByText("请先配置可用模型", { exact: true })).toBeVisible();
  expect(await requestCount(page)).toBe(0);
  await expect(input(page)).toHaveValue(original);
});

test("输入过长和供应商失败可重试且不丢原文", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/");
  await expect(page.getByRole("link", { name: "配置 Agent 模型" })).toContainText("test-model");
  const longText = "字".repeat(24001);
  await input(page).fill(longText);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect(page.getByText("提示词最多支持 24,000 个字符", { exact: true })).toBeVisible();
  expect(await requestCount(page)).toBe(0);
  await input(page).fill(original);
  await page.getByRole("button", { name: "优化提示词", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  await complete(page, "所选模型暂时不可用", 502);
  await expect(page.getByRole("alert").filter({ hasText: "所选模型暂时不可用" })).toBeVisible();
  await expect(input(page)).toHaveValue(original);
  await page.getByRole("button", { name: "重试优化" }).click();
  await expect.poll(() => requestCount(page)).toBe(2);
});

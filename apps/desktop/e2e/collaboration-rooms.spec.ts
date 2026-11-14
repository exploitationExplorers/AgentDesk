import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import type { CollaborationRoomDetail, Provider } from "@agentdesk/shared";

const sidecar = "http://127.0.0.1:17950/api";
let modelServer: Server;
let providerId: string;
let holdModel = false;
const modelRequests: string[] = [];

// 通过本地模型协议端点检验真实 Provider → Agent → 持久化 → UI 链路，不拦截业务 API。
test.beforeAll(async ({ request }) => {
  modelServer = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    modelRequests.push(body);
    if (holdModel) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": waiting for cancellation\n\n");
      return;
    }
    const index = modelRequests.length;
    const content = `本地协议验证第 ${index} 次回复：已核对当前讨论。来源：https://example.com/report\n请由用户确认结论。`;
    const base = {
      id: `collaboration-test-${index}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "collaboration-test",
    };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address();
  if (!address || typeof address === "string") throw new Error("本地模型端口未就绪");
  const response = await request.post(`${sidecar}/providers`, {
    data: {
      name: "协作端到端测试模型",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: ["collaboration-test"],
      defaultModel: "collaboration-test",
      source: "manual",
      enabled: true,
      apiKey: "local-integration-test",
    },
  });
  expect(response.ok()).toBe(true);
  providerId = ((await response.json()) as Provider).id;
});

test.afterAll(async ({ request }) => {
  if (providerId) await request.delete(`${sidecar}/providers/${providerId}`);
  modelServer?.closeAllConnections();
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86_400_000));
    localStorage.setItem("agentdesk-ui", JSON.stringify({ state: { theme: "light" }, version: 0 }));
  });
});

test("真实成员接入、建群、三阶段执行、引用、点名与用户拍板持久化", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/collaboration");
  for (const [name, agent] of [
    ["资料调研员", "research"],
    ["独立核对员", "reviewer"],
  ] as const) {
    await page.getByRole("button", { name: "添加成员", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "添加成员" });
    await dialog.getByLabel("成员名称").fill(name);
    await dialog.getByLabel("Agent 能力").selectOption(agent);
    await dialog.getByLabel("模型服务").selectOption(providerId);
    await dialog.getByLabel("模型", { exact: true }).selectOption("collaboration-test");
    await dialog.getByRole("button", { name: "添加成员", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  await page.getByRole("tab", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "建个群", exact: true }).first().click();
  const group = page.getByRole("dialog", { name: "建个群，分好工" });
  await group.getByLabel("群名称").fill("真实链路核对小组");
  await group.getByLabel("这次一起做什么？").fill("分别调研、核对资料来源，并将结论交给我确认。");
  await group.getByLabel("资料调研员的分工").selectOption("research");
  await group.getByLabel("独立核对员的分工").selectOption("verify");
  await group.getByRole("button", { name: "建群并准备讨论" }).click();
  await expect(page.getByRole("heading", { name: "真实链路核对小组", exact: true })).toBeVisible();
  const roomId = new URLSearchParams(page.url().split("?")[1]).get("room");
  expect(roomId).toBeTruthy();
  const before = modelRequests.length;
  await page.getByRole("button", { name: "开始讨论", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "等你拍板" })).toBeVisible({
    timeout: 30_000,
  });
  const detail = (await (
    await request.get(`${sidecar}/collaboration/rooms/${roomId}`)
  ).json()) as CollaborationRoomDetail;
  expect(detail.room.status).toBe("awaiting_decision");
  expect(
    detail.messages
      .filter((message) => message.author.kind === "agent")
      .map((message) => message.role),
  ).toEqual(["research", "verify", "summarize"]);
  expect(modelRequests.length - before).toBe(3);
  expect(modelRequests.at(-1)).toContain("汇总调研与核查");
  expect(detail.messages.at(-1)?.evidence).toContainEqual({
    url: "https://example.com/report",
    kind: "citation",
  });
  await page.screenshot({ path: testInfo.outputPath("collaboration-real-room.png") });
  await page.getByLabel("发送方式").selectOption("message");
  await page.getByRole("button", { name: "引用", exact: true }).last().click();
  await page.getByRole("button", { name: "点名成员" }).click();
  await page.getByRole("button", { name: "独立核对员", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page
    .getByRole("textbox", { name: "以你自己的身份说点什么" })
    .fill("请保留原始来源，稍后复核。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("请保留原始来源，稍后复核。", { exact: true }).first()).toBeVisible();
  const withMessage = (await (
    await request.get(`${sidecar}/collaboration/rooms/${roomId}`)
  ).json()) as CollaborationRoomDetail;
  expect(withMessage.messages.at(-1)?.author.kind).toBe("owner");
  expect(withMessage.messages.at(-1)?.replyToId).toBe(detail.messages.at(-1)?.id);
  expect(withMessage.messages.at(-1)?.mentionIds).toHaveLength(1);
  expect(modelRequests.length - before).toBe(3);
  await page.getByRole("button", { name: "同意", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已采纳结论" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "已采纳结论" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "真实链路核对小组", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("首页滚动舞台、三步引导与手机入口接入实际路由", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page).toHaveURL(/#\/welcome$/);
  await page.evaluate(() => document.fonts.ready);
  const scroll = page.locator("[data-welcome-scroll]");
  await scroll.evaluate((element) => {
    const stage = element.querySelector<HTMLElement>("#stageWrap")!;
    element.scrollTop = stage.offsetTop + (stage.offsetHeight - element.clientHeight) * 0.71;
  });
  await expect(page.locator("#chat")).toHaveCSS("opacity", "1");
  await expect(page.locator("#side")).toHaveCSS("opacity", "1");
  await expect(page.locator('#chat img[src*="inv-report"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("welcome-group-verification.png") });
  await page.locator("#how").scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "三步就能开始。" })).toBeVisible();
  for (const element of await page.locator("#how [data-r]").all()) {
    await expect(element).toHaveCSS("filter", "none");
  }
  await page.screenshot({ path: testInfo.outputPath("welcome-three-steps.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/welcome");
  await page.getByRole("button", { name: "菜单", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "菜单", exact: true });
  await expect(menu).toBeVisible();
  await menu
    .getByRole("link", { name: /聊天|工作台|群聊/ })
    .last()
    .click();
  await expect(page).toHaveURL(/#\/collaboration/);
  await expect(page.locator(".collaboration-page")).toBeVisible();
  await expect(page.getByRole("tab", { name: "聊天", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("collaboration-mobile.png") });
  await page.goto("/#/");
  await page.getByRole("button", { name: "打开主导航" }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "群聊", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/collaboration/);
  expect(errors).toEqual([]);
});

test("停止真实模型请求后保留记录，最后一轮仍能显式重试", async ({ page, request }) => {
  test.setTimeout(45_000);
  const ids: string[] = [];
  for (const [name, agent] of [
    ["停止测试调研员", "research"],
    ["停止测试核对员", "reviewer"],
  ] as const) {
    const response = await request.post(`${sidecar}/collaboration/members`, {
      data: { name, agent, modelSelection: { providerId, model: "collaboration-test" } },
    });
    expect(response.ok()).toBe(true);
    ids.push(((await response.json()) as { id: string }).id);
  }
  const roomResponse = await request.post(`${sidecar}/collaboration/rooms`, {
    data: {
      name: "可停止的协作",
      topic: "核对资料，等待用户拍板。",
      maxRounds: 1,
      participants: [
        { memberId: ids[0], role: "research" },
        { memberId: ids[1], role: "verify" },
      ],
    },
  });
  expect(roomResponse.ok()).toBe(true);
  const roomId = ((await roomResponse.json()) as { id: string }).id;
  try {
    holdModel = true;
    const before = modelRequests.length;
    await page.goto(`/#/collaboration?room=${roomId}`);
    await page.getByRole("button", { name: "开始讨论", exact: true }).click();
    await expect.poll(() => modelRequests.length).toBeGreaterThan(before);
    await page.getByRole("button", { name: "停止讨论", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已停止" })).toBeVisible();
    holdModel = false;
    await page.getByRole("button", { name: "重试讨论", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "等你拍板" })).toBeVisible({
      timeout: 20_000,
    });
    const detail = (await (
      await request.get(`${sidecar}/collaboration/rooms/${roomId}`)
    ).json()) as CollaborationRoomDetail;
    expect(detail.messages.some((message) => message.status === "cancelled")).toBe(true);
    expect(
      detail.messages.filter(
        (message) => message.author.kind === "agent" && message.status === "complete",
      ),
    ).toHaveLength(3);
    expect(detail.room.round).toBe(1);
  } finally {
    holdModel = false;
    await request.post(`${sidecar}/collaboration/rooms/${roomId}/stop`, { data: {} });
  }
});

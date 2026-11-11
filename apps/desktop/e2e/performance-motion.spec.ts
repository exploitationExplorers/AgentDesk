import { expect, test, type Page } from "@playwright/test";
import { responses } from "../scripts/readme-fixtures";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    const original = SVGPathElement.prototype.getPointAtLength;
    const originalLength = SVGPathElement.prototype.getTotalLength;
    let samples = 0;
    let edgeSamples = 0;
    let edgeLengths = 0;
    SVGPathElement.prototype.getPointAtLength = function (distance) {
      if (this.classList.contains("rf-wire")) samples++;
      if (this.getAttribute("stroke") === "transparent") edgeSamples++;
      return original.call(this, distance);
    };
    SVGPathElement.prototype.getTotalLength = function () {
      if (this.getAttribute("stroke") === "transparent") edgeLengths++;
      return originalLength.call(this);
    };
    Object.assign(window, {
      motionSamples: () => samples,
      edgeSamples: () => edgeSamples,
      edgeLengths: () => edgeLengths,
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/events" || path.endsWith("/stream"))
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ json: responses[path as keyof typeof responses] ?? [] });
  });
}

const samples = (page: Page) =>
  page.evaluate(() => (window as unknown as { motionSamples: () => number }).motionSamples());

test("流程路由响应减少动画偏好切换，并在离屏或页面隐藏时暂停", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 500 });
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/learning");
  const stage = page.locator("svg:has(.rf-wire)");
  await stage.scrollIntoViewIfNeeded();
  await expect(page.getByText("本轮完成", { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  expect(await samples(page)).toBe(0);
  await expect(page.locator(".rf-packet")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => samples(page)).toBeGreaterThan(5);

  // 用实际滚动触发 IntersectionObserver，再恢复到连线区域。
  await stage.evaluate((el) => {
    let scroller = el.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight)
      scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const offscreen = await samples(page);
  await page.waitForTimeout(350);
  expect(await samples(page)).toBe(offscreen);
  await stage.scrollIntoViewIfNeeded();
  await expect.poll(() => samples(page)).toBeGreaterThan(offscreen);

  // 模拟浏览器 visibilitychange，检查暂停分支与恢复后的调度。
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await samples(page);
  await page.waitForTimeout(350);
  expect(await samples(page)).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => samples(page)).toBeGreaterThan(hidden);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByText("本轮完成", { exact: true })).toBeVisible();
  const reduced = await samples(page);
  await page.waitForTimeout(350);
  expect(await samples(page)).toBe(reduced);
  await expect(page.locator(".rf-packet")).toHaveCount(0);
});

test("编码流程连线缓存长度，并响应运行时减少动画及不可见状态", async ({ page }) => {
  await fixture(page);
  const task = {
    id: "motion-code",
    title: "动画暂停回归",
    goal: "检查运行中的连线",
    agent: "code",
    conversationId: "motion-code-chat",
    status: "running",
    currentRunId: "motion-run",
    requiresPlanApproval: false,
    pendingApprovalId: null,
    createdAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
    closedAt: null,
  };
  const records = [
    {
      type: "run_started",
      runId: "motion-run",
      parentRunId: null,
      agent: "code",
      trigger: "create",
    },
    {
      type: "tool_call",
      id: "motion-tool",
      agent: "code",
      name: "fs.read",
      args: { path: "src/main.ts" },
    },
  ].map((event, index) => ({
    seq: index + 1,
    taskId: task.id,
    runId: task.currentRunId,
    parentRunId: null,
    createdAt: task.createdAt,
    event,
  }));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (path === "/tasks") return route.fulfill({ json: [task] });
    if (path === "/tasks/motion-code/runs")
      return route.fulfill({
        json: [
          {
            id: task.currentRunId,
            taskId: task.id,
            agent: "code",
            kind: "root",
            parentRunId: null,
            status: "running",
            trigger: "create",
            createdAt: task.createdAt,
          },
        ],
      });
    if (path === "/tasks/motion-code/stream")
      return route.fulfill({
        contentType: "text/event-stream",
        body: records.map((r) => `id: ${r.seq}\ndata: ${JSON.stringify(r)}\n\n`).join(""),
      });
    if (path === "/approvals") return route.fulfill({ json: [] });
    return route.fallback();
  });
  const edgeSamples = () =>
    page.evaluate(() => (window as unknown as { edgeSamples: () => number }).edgeSamples());
  const edgeLengths = () =>
    page.evaluate(() => (window as unknown as { edgeLengths: () => number }).edgeLengths());
  await page.goto("/#/code?task=motion-code");
  await page.getByRole("tab", { name: "流程图" }).click();
  await expect(page.locator(".code-flow-packet")).toHaveCount(1);
  await expect.poll(edgeSamples).toBeGreaterThan(5);
  const lengths = await edgeLengths();
  const visible = await edgeSamples();
  await page.waitForTimeout(250);
  expect(await edgeSamples()).toBeGreaterThan(visible);
  expect(await edgeLengths()).toBe(lengths);

  const viewport = page.locator(".react-flow__viewport");
  const transform = await viewport.evaluate((el) => (el as HTMLElement).style.transform);
  await viewport.evaluate((el) => {
    (el as HTMLElement).style.transform = "translate(10000px,10000px)";
  });
  await page.waitForTimeout(150);
  const offscreen = await edgeSamples();
  await page.waitForTimeout(250);
  expect(await edgeSamples()).toBe(offscreen);
  await viewport.evaluate((el, value) => {
    (el as HTMLElement).style.transform = value;
  }, transform);
  await expect.poll(edgeSamples).toBeGreaterThan(offscreen);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  const still = await edgeSamples();
  await page.waitForTimeout(250);
  expect(await edgeSamples()).toBe(still);
  await expect(page.locator(".code-flow-packet")).toHaveAttribute("opacity", "0.85");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(edgeSamples).toBeGreaterThan(still);
});

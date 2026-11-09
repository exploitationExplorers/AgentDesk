import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { demoTime, deployRun, feed, records, responses, task, workflow } from "./readme-fixtures";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = resolve(desktopDir, "../../assets/screenshots");
// 截图仅启动 Vite；API 全部拦截，不启动 sidecar 或调用真实模型。
process.env.VITE_SIDECAR_URL = "http://127.0.0.1:17951";
const server = await createServer({
  root: desktopDir,
  configFile: resolve(desktopDir, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 1431, strictPort: true, open: false },
});
await server.listen();
try {
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      colorScheme: "dark",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const failures: string[] = [];
    await context.addInitScript(() => {
      localStorage.setItem(
        "agentdesk-ui",
        JSON.stringify({ state: { theme: "dark" }, version: 0 }),
      );
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/")) {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
        const path = url.pathname.slice(4);
        if (path === "/events")
          return route.fulfill({ contentType: "text/event-stream", body: ": demo\n\n" });
        if (path === `/deploy/runs/${deployRun.id}/events`)
          return route.fulfill({
            contentType: "text/event-stream",
            body: `data: ${JSON.stringify({ type: "run", run: deployRun })}\n\n`,
          });
        if (path === "/feed")
          return route.fulfill({
            json: feed.filter(
              (item) =>
                !url.searchParams.get("source") || item.source === url.searchParams.get("source"),
            ),
          });
        if (path === `/tasks/${task.id}/events`)
          return route.fulfill({
            json: records.filter(
              (record) => record.seq > Number(url.searchParams.get("after") ?? 0),
            ),
          });
        if (path === `/tasks/${task.id}/stream`)
          return route.fulfill({
            contentType: "text/event-stream",
            body: records
              .map((record) => `id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`)
              .join(""),
          });
        if (path in responses) return route.fulfill({ json: responses[path] });
        failures.push(`Missing demo response: ${path}`);
        return route.abort();
      }
      if (url.origin === "http://127.0.0.1:1431") return route.continue();
      failures.push(`Unexpected external request: ${url.origin}${url.pathname}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    await page.clock.setFixedTime(new Date(demoTime));
    await mkdir(outputDir, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (img) => img.decode()));
      });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: resolve(outputDir, `${name}.png`), animations: "disabled" });
      console.info(`Captured ${name}.png`);
    };

    await page.goto("http://127.0.0.1:1431/#/code?task=demo-session");
    await expect(page.getByTestId("code-diff")).toContainText("sessionStorage");
    await expect(page.getByRole("button", { name: "确认完成", exact: true })).toBeVisible();
    await capture("code");

    await page.goto("http://127.0.0.1:1431/#/");
    await expect(page.getByRole("heading", { name: /今天想做什么/ })).toBeVisible();
    await expect(page.getByRole("textbox").first()).toBeVisible();
    await capture("bot");

    await page.setViewportSize({ width: 1240, height: 860 });
    await page.goto("http://127.0.0.1:1431/#/projects");
    await expect(page.getByText("portal-web", { exact: true })).toBeVisible();
    await capture("projects");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://127.0.0.1:1431/#/feed");
    await expect(page.getByText("openai/codex", { exact: true })).toBeVisible();
    await capture("feed");

    await page.goto("http://127.0.0.1:1431/#/deploy");
    await expect(page.getByText("验证服务健康状态", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "构建生产版本" }).click();
    await page.getByRole("button", { name: "验证服务健康状态" }).click();
    await capture("deploy");

    await page.goto(`http://127.0.0.1:1431/#/workflows/${workflow.id}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(workflow.nodes.length);
    await expect(page.locator(".react-flow__nodes")).toBeVisible();
    // 等待 React Flow 完成节点测量和 fitView 动画。
    await page.waitForFunction(
      () => document.querySelectorAll(".react-flow__edge-path").length === 5,
    );
    await page.waitForTimeout(600);
    await page.locator('.react-flow__node[data-id="approve"]').click();
    await capture("workflow");

    await page.goto("http://127.0.0.1:1431/#/automations");
    await expect(page.getByRole("heading", { name: "每日项目巡检", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "运行记录", exact: true }).first().click();
    await expect(page.getByText("查看会话与成果", { exact: true }).first()).toBeVisible();
    await capture("automations");

    await page.goto("http://127.0.0.1:1431/#/learning");
    await expect(page.getByText("掌握 TypeScript 工程实践", { exact: true })).toBeVisible();
    await capture("learning");

    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto("http://127.0.0.1:1431/#/learning/interview");
    await expect(page.getByRole("heading", { name: "面试题", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "展开参考答案" }).click();
    await expect(page.locator(".iv-markdown")).toContainText("词法环境");
    await page.locator(".iv-page").evaluate((element) => element.scrollTo(0, 0));
    await expect(page.getByRole("heading", { name: "面试题", exact: true })).toBeInViewport();
    await capture("interview");

    if (failures.length) throw new Error([...new Set(failures)].join("\n"));
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

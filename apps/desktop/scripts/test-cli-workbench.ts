/** 验证真实 npm 产物：一次性连接、浏览器读写、任务同步、SSE 与会话失效。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const execute = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const installedPackage = process.argv[2] ? resolve(process.argv[2]) : resolve(desktop, "../cli");
const entry = join(installedPackage, "dist/index.mjs");
const dataHome = mkdtempSync(join(tmpdir(), "agentdesk-web-smoke-"));
const projectPath = join(dataHome, "project");
mkdirSync(projectPath);
const command = (args: string[]) =>
  execute(process.execPath, [entry, ...args, "--data-dir", dataHome], {
    cwd: projectPath,
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, AGENTDESK_SMOKE_KEY: "local-web-smoke", AGENTDESK_SKIP_UPDATE: "1" },
  });
const state = () =>
  JSON.parse(readFileSync(join(dataHome, "service.json"), "utf8")) as {
    port: number;
    token: string;
  };
const taskTitle = "验证浏览器与 CLI 共享任务";
const model = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "web-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "工作台任务同步成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise<void>((ready) => model.listen(0, "127.0.0.1", ready));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await execute("git", ["init", projectPath], { windowsHide: true });
  await command(["start", "--port", "0"]);
  const modelAddress = model.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  await command([
    "init",
    "--base-url",
    `http://127.0.0.1:${modelAddress.port}/v1`,
    "--model",
    "local-web-smoke",
    "--api-key-env",
    "AGENTDESK_SMOKE_KEY",
  ]);
  await command(["run", taskTitle, "--agent", "code", "--json"]);
  const instance = state();
  const origin = `http://127.0.0.1:${instance.port}`;
  const link = JSON.parse((await command(["web", "--json"])).stdout) as { url: string };
  assert.equal(new URL(link.url).origin, origin);
  assert.ok(!link.url.includes(instance.token));

  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const apiPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      assert.equal(url.origin, origin, "工作台 API 必须连接当前 CLI 实例");
      assert.equal(url.searchParams.has("token"), false);
      apiPaths.push(url.pathname);
    }
  });
  await page.goto(link.url);
  await expect(page.getByRole("link", { name: "编码现场", exact: true })).toBeVisible();
  assert.ok(!page.url().includes("ticket="));
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === `agentdesk-web-${instance.port}`,
  );
  assert.ok(session?.httpOnly);
  assert.equal(session.sameSite, "Strict");
  await page.reload();
  await page.getByRole("link", { name: "编码现场", exact: true }).click();
  await expect(page.getByText("与 CLI 同步", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "CLI 会话", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(taskTitle) })).toBeVisible();
  await expect(page.getByText("工作台任务同步成功", { exact: true }).first()).toBeVisible();
  // 老书签里的 source=cli 也不得跳到另一个默认实例。
  await page.goto(`${origin}/#/code?source=cli`);
  await expect(page.getByText("与 CLI 同步", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(taskTitle) })).toBeVisible();
  assert.ok(!apiPaths.some((path) => path.startsWith("/api/cli-monitor")));
  const output = resolve(desktop, "../../.workflow/.scratchpad");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "cli-workbench.png") });

  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目中心", exact: true })).toBeVisible();
  await page.goto(`${origin}/#/settings?tab=general`);
  const scanRoot = join(dataHome, "projects");
  await page.getByRole("textbox").first().fill(scanRoot);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const saved = await fetch(`${origin}/api/settings`, {
    headers: { "X-AgentDesk-Token": instance.token },
  });
  assert.deepEqual((await saved.json()).scanRoots, [scanRoot]);
  const health = await page.evaluate(async () => (await fetch("/api/health")).json());
  assert.equal(resolve(health.dataDir), resolve(dataHome, "data"));
  // 原生 EventSource 也使用同源 Cookie，无需在 URL 放令牌。
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const events = new EventSource("/api/events");
        const timer = setTimeout(() => {
          events.close();
          reject(new Error("SSE 超时"));
        }, 20_000);
        events.onmessage = () => {
          clearTimeout(timer);
          events.close();
          resolve();
        };
        events.onerror = () => {
          clearTimeout(timer);
          events.close();
          reject(new Error("SSE 连接失败"));
        };
      }),
  );
  assert.deepEqual(errors, []);

  const stranger = await browser.newContext();
  const guest = await stranger.newPage();
  await guest.goto(link.url);
  await expect(guest.getByText("连接已失效", { exact: false })).toBeVisible();
  assert.equal((await stranger.request.get(`${origin}/api/health`)).status(), 401);
  await stranger.close();
  await command(["restart"]);
  await page.reload();
  await expect(page.getByText("请在终端运行 agentdesk web", { exact: false })).toBeVisible();
  assert.equal((await context.request.get(`${origin}/api/health`)).status(), 401);
  const fresh = JSON.parse((await command(["web", "--json"])).stdout) as { url: string };
  await page.goto(fresh.url);
  await expect(page.getByRole("link", { name: "编码现场", exact: true })).toBeVisible();
  console.info(
    JSON.stringify(
      {
        ok: true,
        installedPackage,
        checks: [
          "connect",
          "refresh",
          "shared-tasks",
          "custom-data-dir",
          "settings-write",
          "SSE",
          "ticket-replay",
          "restart-reconnect",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await command(["stop"]).catch(() => {});
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(() => done()));
}

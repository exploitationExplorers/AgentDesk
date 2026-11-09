import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

/**
 * 对正在运行的本地工作台采样；不发送聊天、不触发部署。
 * pnpm --filter @agentdesk/desktop perf:ui --output ../../test-results/ui-performance
 * --dist ../../.tmp/perf-dist 可在相同 origin/API 下对照生产构建。
 * --trace 额外导出可导入 Chromium Performance 面板的时间线。
 */
const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:1420" },
    output: { type: "string" },
    dist: { type: "string" },
    channel: { type: "string", default: "msedge" },
    trace: { type: "boolean", default: false },
  },
});
const output = resolve(
  values.output ?? fileURLToPath(new URL("../../../test-results/ui-performance", import.meta.url)),
);
await mkdir(output, { recursive: true });
type Sample = { frames: number[]; tasks: number[] };
type ProbeWindow = Window & { __uiPerf: Sample | null };
const browser = await chromium.launch({ channel: values.channel, headless: true });
const watchdog = setTimeout(() => {
  console.error("UI performance probe timed out");
  process.exit(2);
}, 180_000);

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1.5,
  });
  // 拦截生产静态资源后，Chromium 仍需显式授权页面访问本地 sidecar。
  await page.context().grantPermissions(["local-network-access"], { origin: values.url });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  const apiErrors = new Set<string>();
  const dataCounts: Record<string, number> = {};
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText;
    if (url.pathname.startsWith("/api/") && failure !== "net::ERR_ABORTED") {
      apiErrors.add(`${failure ?? "Network failure"} ${url.origin}${url.pathname}`);
    }
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    if (response.status() >= 400) apiErrors.add(`${response.status()} ${url.pathname}`);
    if (url.pathname === "/api/projects" || url.pathname === "/api/feed") {
      const data: unknown = await response.json().catch(() => null);
      if (Array.isArray(data)) dataCounts[url.pathname + url.search] = data.length;
    }
  });
  if (values.dist) {
    const dist = resolve(values.dist);
    const origin = new URL(values.url).origin;
    await page.route(`${origin}/**`, async (route) => {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
      if (pathname.startsWith("/api/")) return route.continue();
      const file = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
      const within = relative(dist, file);
      if (within.startsWith("..") || isAbsolute(within)) return route.abort();
      const type: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
      };
      await route.fulfill({
        body: await readFile(file),
        contentType: type[extname(file)] ?? "application/octet-stream",
      });
    });
  }
  // 字符串直接在浏览器执行，避免 tsx 为函数注入 Node 侧的命名辅助函数。
  await page.addInitScript({
    content: `
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: false }, version: 0 }),
    );
    const probe = window;
    probe.__uiPerf = null;
    new PerformanceObserver((list) => {
      probe.__uiPerf?.tasks.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask" });
    let last = 0;
    function frame(now) {
      if (probe.__uiPerf && last) probe.__uiPerf.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  `,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const system = await browser.newBrowserCDPSession();
  const info = await system.send("SystemInfo.getInfo");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
    );
  const results: Array<Record<string, number | string>> = [];
  const phase = async (name: string, work: () => Promise<void>) => {
    await page.waitForTimeout(600);
    const before = await metrics();
    await page.evaluate(() => {
      (window as unknown as ProbeWindow).__uiPerf = { frames: [], tasks: [] };
    });
    const start = performance.now();
    await work();
    const sample = await page.evaluate(() => {
      const probe = window as unknown as ProbeWindow;
      const result = probe.__uiPerf!;
      probe.__uiPerf = null;
      return result;
    });
    const after = await metrics();
    const frames = sample.frames.sort((a, b) => a - b);
    if (!frames.length) throw new Error(`No animation frames captured during ${name}`);
    const result: Record<string, number | string> = {
      name,
      ms: Math.round(performance.now() - start),
      frames: frames.length,
      p95: Math.round(frames[Math.floor(frames.length * 0.95)] ?? 0),
      max: Math.round(frames.at(-1) ?? 0),
      over50: frames.filter((n) => n > 50).length,
      longTasks: sample.tasks.length,
      longTaskMs: Math.round(sample.tasks.reduce((a, b) => a + b, 0)),
    };
    for (const key of [
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "LayoutCount",
      "RecalcStyleCount",
    ]) {
      result[key] = Math.round(
        (after[key]! - before[key]!) * (key.endsWith("Duration") ? 1000 : 1),
      );
    }
    results.push(result);
    console.info(JSON.stringify(result));
  };

  await page.goto(values.url, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "发送消息" }).waitFor();
  await page.locator(".sf-card").first().waitFor();
  await page.waitForTimeout(1500);
  if (values.trace)
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,v8.execute,toplevel,disabled-by-default-devtools.timeline.frame",
      transferMode: "ReturnAsStream",
    });
  await phase("idle", () => page.waitForTimeout(2500));
  await phase("sidebar-hover", async () => {
    for (let i = 0; i < 3; i++)
      for (const label of ["编码", "项目", "部署", "热榜", "成长", "Bot"]) {
        await page.getByRole("link", { name: label, exact: true }).hover();
        await page.waitForTimeout(90);
      }
    await page.mouse.move(500, 40);
    await page.waitForTimeout(400);
  });
  await page.locator(".sf-card").first().scrollIntoViewIfNeeded();
  await phase("cards-hover", async () => {
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 4; j++) {
        await page.locator(".sf-card").nth(j).hover();
        await page.waitForTimeout(550);
      }
    await page.mouse.move(500, 40);
    await page.waitForTimeout(500);
  });
  await page.screenshot({ path: resolve(output, "home.png") });
  await phase("home-scroll", async () => {
    await page.mouse.move(1000, 650);
    for (let i = 0; i < 16; i++) {
      await page.mouse.wheel(0, i % 8 < 4 ? 125 : -125);
      await page.waitForTimeout(100);
    }
  });
  await phase("navigation", async () => {
    for (const label of ["项目", "部署", "热榜", "编码", "设置", "Bot"]) {
      await page.getByRole("link", { name: label, exact: true }).click();
      await page.waitForTimeout(700);
    }
  });
  if (values.trace) {
    const completed = new Promise<string>((resolve) =>
      cdp.once("Tracing.tracingComplete", (event) => resolve(event.stream!)),
    );
    await cdp.send("Tracing.end");
    const handle = await completed;
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle });
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle });
    await writeFile(resolve(output, "timeline.json"), Buffer.concat(chunks));
  }
  const report = {
    capturedAt: new Date().toISOString(),
    url: values.url,
    build: values.dist ? "production" : "running-server",
    trace: values.trace,
    browser: browser.version(),
    gpu: info.gpu.devices,
    renderer: info.gpu.auxAttributes,
    viewport: page.viewportSize(),
    deviceScaleFactor: 1.5,
    note: "Headless rAF intervals measure scheduling delays, not presentation FPS. Compare the same machine, data, build mode and trace setting.",
    dataCounts,
    results,
    errors,
    apiErrors: [...apiErrors],
  };
  await writeFile(resolve(output, "metrics.json"), JSON.stringify(report, null, 2));
  console.info(`Performance report: ${resolve(output, "metrics.json")}`);
  if (dataCounts["/api/projects"] === undefined) apiErrors.add("Project data was not loaded");
  if (errors.length || apiErrors.size) {
    console.error({ errors, apiErrors: [...apiErrors] });
    process.exitCode = 1;
  }
} finally {
  clearTimeout(watchdog);
  await browser.close();
}

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { responses } from "./readme-fixtures";
import { discussionDemo, teamDemo, teamDemoSession, teamDemoTime } from "./readme-team-fixtures";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = resolve(desktopDir, "../../assets/screenshots");
process.env.VITE_SIDECAR_URL = "http://127.0.0.1:17952";
process.env.VITE_SIDECAR_TOKEN = "";
const origin = "http://127.0.0.1:1432";
const server = await createServer({
  root: desktopDir,
  configFile: resolve(desktopDir, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 1432, strictPort: true, open: false },
});
await server.listen();
try {
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1.5,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const failures: string[] = [];
    await context.addInitScript((session) => {
      localStorage.setItem("agentdesk.team.sessions", JSON.stringify([session]));
      localStorage.setItem(
        "agentdesk-ui",
        JSON.stringify({ state: { theme: "light" }, version: 0 }),
      );
      localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    }, teamDemoSession);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
      if (url.pathname === "/team-api/v1/room") return route.fulfill({ json: teamDemo });
      if (url.pathname.startsWith("/api/")) {
        const path = url.pathname.slice(4);
        const collaboration: Record<string, unknown> = {
          "/collaboration/sources": { agents: [], providers: [] },
          "/collaboration/members": discussionDemo.members,
          "/collaboration/rooms": [discussionDemo.room],
          "/collaboration/rooms/demo-discussion": discussionDemo,
        };
        if (path in collaboration) return route.fulfill({ json: collaboration[path] });
        if (path === "/events")
          return route.fulfill({ contentType: "text/event-stream", body: ": demo\n\n" });
        if (path in responses) return route.fulfill({ json: responses[path] });
        failures.push("Missing fixture: " + path);
        return route.abort();
      }
      if (url.origin === origin) return route.continue();
      failures.push("Unexpected network request: " + url.origin + url.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    await page.clock.setFixedTime(new Date(teamDemoTime));
    await mkdir(outputDir, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (img) => img.decode()));
      });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: resolve(outputDir, name + ".png"), animations: "disabled" });
      console.info("Captured " + name + ".png");
    };
    await page.goto(origin + "/#/team");
    await expect(
      page.getByRole("heading", { name: teamDemo.room.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("已核对接口契约：", { exact: false })).toBeVisible();
    await capture("team-chat");
    await page.getByRole("button", { name: "任务与进度", exact: true }).click();
    await expect(page.getByRole("button", { name: "领取任务", exact: true })).toBeVisible();
    await capture("team-tasks");
    await page.getByRole("button", { name: "成员与连接", exact: true }).click();
    await expect(page.getByText("已配对 · 本机执行器未在线", { exact: true })).toBeVisible();
    await capture("team-members");
    await page.goto(origin + "/#/collaboration?room=demo-discussion");
    await expect(
      page.getByRole("heading", { name: discussionDemo.room.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("请确认是否采用。", { exact: false })).toBeVisible();
    await capture("collaboration");
    if (failures.length) throw Error([...new Set(failures)].join("\n"));
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

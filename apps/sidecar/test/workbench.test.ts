import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

const origin = "http://127.0.0.1:17971";
const master = "workbench-test-master";
let container: Container;
let app: Hono;
let root: string;
const request = (path: string, init?: RequestInit) => app.request(`${origin}${path}`, init);
const issue = async () => {
  const res = await request("/api/cli/web-session", {
    method: "POST",
    headers: { "X-AgentDesk-Token": master },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { path: string };
  expect(body.path).not.toContain(master);
  return new URL(body.path, origin).hash.slice("#ticket=".length);
};
const exchange = (ticket: string, suppliedOrigin = origin) =>
  request("/auth/exchange", {
    method: "POST",
    headers: { origin: suppliedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-web-test-"));
  const web = join(root, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<html>workbench-app</html>");
  writeFileSync(join(web, "assets", "app.js"), "window.workbench = true;");
  writeFileSync(join(root, "private.txt"), "private outside web root");
  container = await createContainer(
    loadConfig({ AGENTDESK_DATA_DIR: join(root, "data"), AGENTDESK_TOKEN: master }),
    { inMemory: true },
  );
  app = createApp(container, { webRoot: web });
  app.get("/api/extension", (c) => c.json({ ok: true }));
});
afterAll(async () => {
  await container.dispose();
});

describe("CLI 浏览器工作台", () => {
  it("未登录只能看到连接指引，不能获取 API、登录链接或令牌", async () => {
    const landing = await (await request("/")).text();
    expect(landing).toContain("agentdesk web");
    expect(landing).not.toContain(master);
    expect(landing).not.toContain("workbench-app");
    expect((await request("/api/health")).status).toBe(401);
    expect((await request("/api/cli/web-session", { method: "POST" })).status).toBe(401);
    expect((await request("/auth/exchange", { method: "POST" })).status).toBe(403);
  });

  it("一次性链接换取 HttpOnly 会话，页面与读写 API 共用实例", async () => {
    const ticket = await issue();
    const connected = await exchange(ticket);
    expect(connected.status).toBe(200);
    expect(connected.headers.get("cache-control")).toBe("no-store");
    const setCookie = connected.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(master);
    const cookie = setCookie.split(";")[0]!;
    expect((await exchange(ticket)).status).toBe(401);
    expect(await (await request("/", { headers: { cookie } })).text()).toContain("workbench-app");
    expect((await request("/api/health", { headers: { cookie } })).status).toBe(200);
    expect(
      (
        await request("/api/settings", {
          method: "PUT",
          headers: { cookie, origin, "Content-Type": "application/json" },
          body: JSON.stringify({ theme: "light" }),
        })
      ).status,
    ).toBe(200);
    const settings = await request("/api/settings", { headers: { "X-AgentDesk-Token": master } });
    expect(await settings.json()).toMatchObject({ theme: "light" });
    // 扩展路由在 createApp 之后注册，不能被静态资源兜底吞掉。
    expect((await request("/api/extension", { headers: { cookie } })).status).toBe(200);
    expect((await request("/api/extension")).status).toBe(401);
  });

  it("拒绝跨站、其他本机端口、无来源写请求与 DNS rebinding", async () => {
    const ticket = await issue();
    expect((await exchange(ticket, "https://attacker.example")).status).toBe(403);
    expect((await exchange(ticket, "http://127.0.0.1:9999")).status).toBe(403);
    const cookie = (await exchange(ticket)).headers.get("set-cookie")!.split(";")[0]!;
    const foreignHeaders: Record<string, string>[] = [
      { cookie, origin: "https://attacker.example" },
      { cookie, origin: "http://127.0.0.1:9999" },
      { cookie, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of foreignHeaders)
      expect((await request("/api/health", { headers })).status).toBe(401);
    expect(
      (
        await request("/api/settings", {
          method: "PUT",
          headers: { cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request("http://attacker.example:17971/", { headers: { cookie } })).status,
    ).toBe(403);
  });

  it("过期链接与服务重建后的旧会话失效", async () => {
    const ticket = await issue();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    try {
      expect((await exchange(ticket)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
    const cookie = (await exchange(await issue())).headers.get("set-cookie")!.split(";")[0]!;
    const restarted = createApp(container, { webRoot: join(root, "web") });
    expect((await restarted.request(`${origin}/api/health`, { headers: { cookie } })).status).toBe(
      401,
    );
  });

  it("仅提供发行资源，路径穿越与源文件不可访问", async () => {
    expect((await request("/assets/app.js")).headers.get("content-type")).toContain(
      "text/javascript",
    );
    for (const path of [
      "/package.json",
      "/.env",
      "/assets/..%2f..%2fprivate.txt",
      "/assets/..%5c..%5cprivate.txt",
      "/assets/%00app.js",
      "/assets/missing.js",
    ]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private outside web root");
    }
  });
});

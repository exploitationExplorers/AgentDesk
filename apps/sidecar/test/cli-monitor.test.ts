import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@agentdesk/shared";
import { cliMonitorRoutes } from "../src/http/routes/cli-monitor";

let home: string;
let app: Hono;
const state = {
  schemaVersion: 1,
  port: 17891,
  pid: 123,
  instanceId: "3375af89-fcb5-4ae8-8b77-9fc98a56df67",
  token: "a".repeat(64),
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentdesk-cli-monitor-"));
  await writeFile(join(home, "service.json"), JSON.stringify(state));
  app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? 400 : 500),
  );
  app.route("/api", cliMonitorRoutes(home));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

it("核对 CLI 实例身份，只连接回环地址并保留令牌在服务端", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ instanceId: state.instanceId, pid: state.pid }))
    .mockResolvedValueOnce(Response.json([{ id: "task-1" }]));
  vi.stubGlobal("fetch", fetcher);
  const response = await app.request("/api/cli-monitor/tasks?token=desktop-token");
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("task-1");
  expect(body).not.toContain(state.token);
  expect(fetcher.mock.calls[1]?.[0]).toBe("http://127.0.0.1:17891/api/tasks?");
  expect(fetcher.mock.calls[1]?.[1].headers["X-AgentDesk-Token"]).toBe(state.token);
});
it("身份不匹配时拒绝转发，未知接口不能成为通用代理", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ instanceId: "different", pid: 123 }));
  vi.stubGlobal("fetch", fetcher);
  expect((await app.request("/api/cli-monitor/tasks")).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (await app.request("/api/cli-monitor/settings", { method: "POST", body: "{}" })).status,
  ).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("放行 stream 路径并透传真实 SSE 响应头，不覆写成 JSON", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ instanceId: state.instanceId, pid: state.pid }))
    .mockResolvedValueOnce(
      new Response("data: hello\n\n", {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const response = await app.request("/api/cli-monitor/tasks/task-1/stream?token=desktop-token");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain("data: hello");
});
it("EventSource 重连时把 Last-Event-ID 请求头换算成 after 查询参数转发", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ instanceId: state.instanceId, pid: state.pid }))
    .mockResolvedValueOnce(new Response("", { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  await app.request("/api/cli-monitor/tasks/task-1/stream?token=desktop-token&after=0", {
    headers: { "Last-Event-ID": "42" },
  });
  const forwardedUrl = fetcher.mock.calls[1]?.[0] as string;
  expect(forwardedUrl).toContain("after=42");
});

it("成果下载透传附件和隔离响应头，同时拒绝 CLI 成果写入", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ instanceId: state.instanceId, pid: state.pid }))
    .mockResolvedValueOnce(
      new Response("# 报告", {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": "attachment; filename=report.md",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "X-AgentDesk-Token": state.token,
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const path = "/api/cli-monitor/tasks/task-1/artifacts/artifact-1";
  const response = await app.request(`${path}/download`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  expect(response.headers.get("content-disposition")).toBe("attachment; filename=report.md");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-agentdesk-token")).toBeNull();
  expect(await response.text()).toBe("# 报告");
  expect((await app.request(`${path}/versions`, { method: "POST", body: "{}" })).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("成果正文仅开放 GET 只读代理", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ instanceId: state.instanceId, pid: state.pid }))
    .mockResolvedValueOnce(Response.json({ content: "报告正文", encoding: "utf8" }));
  vi.stubGlobal("fetch", fetcher);
  const path = "/api/cli-monitor/tasks/task-1/artifacts/artifact-1/content";
  expect(await (await app.request(path)).json()).toMatchObject({ content: "报告正文" });
  expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

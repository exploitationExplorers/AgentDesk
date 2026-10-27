import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { startSidecar } from "../src/runtime";
import { aiCommitWorkerPath } from "../src/worker-path";

function config() {
  return loadConfig({
    AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-runtime-")),
    AGENTDESK_PORT: "0",
    AGENTDESK_TOKEN: "runtime-test-token",
  });
}

describe("独立运行服务", () => {
  it("真实监听、沿用认证、扩展路由并可重复关闭", async () => {
    const runtime = await startSidecar(config(), {
      schedule: false,
      configureApp(app) {
        app.get("/api/runtime-test", (c) => c.json({ ok: true }));
      },
    });
    try {
      const url = `http://127.0.0.1:${runtime.port}/api`;
      expect((await fetch(`${url}/health`)).status).toBe(401);
      const health = await fetch(`${url}/health`, {
        headers: { "X-AgentDesk-Token": "runtime-test-token" },
      });
      expect(await health.json()).toMatchObject({ ok: true });
      expect((await fetch(`${url}/runtime-test`)).status).toBe(401);
      const response = await fetch(`${url}/runtime-test`, {
        headers: { "X-AgentDesk-Token": "runtime-test-token" },
      });
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      const first = runtime.close();
      expect(runtime.close()).toBe(first);
      await first;
    }
  });

  it("端口占用时启动失败并释放数据库", async () => {
    const first = await startSidecar(config(), { schedule: false });
    const next = { ...config(), port: first.port };
    try {
      await expect(startSidecar(next, { schedule: false })).rejects.toThrow();
      const retry = await startSidecar({ ...next, port: 0 }, { schedule: false });
      await retry.close();
    } finally {
      await first.close();
    }
  });

  it("源码运行能定位独立提交 worker", () => {
    expect(aiCommitWorkerPath().replaceAll("\\", "/")).toMatch(
      /apps\/sidecar\/scripts\/ai-commit-worker\.mjs$/,
    );
  });
});

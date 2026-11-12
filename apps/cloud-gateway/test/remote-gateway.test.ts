import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteActor, RemoteScope } from "@agentdesk/shared";
import { commandDigest, RunnerClient } from "../src/remote/client";
import { RemoteRoutingStore } from "../src/remote/store";
import { SESSION_IDLE_MS } from "../src/auth/session-policy";
let db: Database.Database;
let store: RemoteRoutingStore;
const scope: RemoteScope = {
  userId: "owner-id",
  hostId: "cloud",
  projectId: "project-1",
  workspaceId: "project-1",
};
const actor: RemoteActor = {
  userId: "owner-id",
  sessionId: "session-id",
  recentAuthAt: "2026-11-08T00:00:00.000Z",
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL, "expiresAt" TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    actor.sessionId,
    actor.userId,
    now,
    now,
    new Date(Date.now() + 60000).toISOString(),
  );
  store = new RemoteRoutingStore(db);
});
afterEach(() => db.close());
describe("Gateway 远程任务路由记录", () => {
  it("任务提交幂等并在同一请求键绑定不同内容时冲突", async () => {
    const submission = {
      scope,
      actor,
      requestId: "request-1",
      payloadHash: "a".repeat(64),
      taskId: null,
      active: true,
    };
    const claimed = await store.claim(submission);
    expect(claimed).toMatchObject({ ...submission, action: "task.create", accepted: false });
    expect(claimed.createdAt).toEqual(expect.any(Number));
    expect(await store.claim(submission)).toEqual(claimed);
    expect(await store.active()).toEqual([claimed]);
    await expect(store.claim({ ...submission, payloadHash: "b".repeat(64) })).rejects.toThrow(
      "该请求已用于其他任务内容",
    );
  });
  it("只续有效会话且后台读取不会延长用户空闲期限", async () => {
    expect(await store.sessionAlive(actor)).toBe(true);
    const before = db.prepare('SELECT "updatedAt" FROM session WHERE id=?').get(actor.sessionId);
    expect(await store.sessionAlive(actor)).toBe(true);
    expect(db.prepare('SELECT "updatedAt" FROM session WHERE id=?').get(actor.sessionId)).toEqual(
      before,
    );
    db.prepare('UPDATE session SET "updatedAt"=? WHERE id=?').run(
      new Date(Date.now() - SESSION_IDLE_MS - 1).toISOString(),
      actor.sessionId,
    );
    expect(await store.sessionAlive(actor)).toBe(false);
  });
  it("命令绑定规范化负载摘要，内部客户端拒绝路径逃逸并隐藏上游响应", async () => {
    let captured: RequestInit | undefined;
    const client = new RunnerClient(
      { runnerUrl: "http://runner:17893", remoteToken: "x".repeat(32) },
      async (_url, init) => {
        captured = init;
        return Response.json({ status: "ok" });
      },
    );
    const payload = { z: 3, nested: { b: true, a: null }, a: [1, 2] };
    const command = client.command(scope, actor, "task.create", payload, "request-2");
    expect(command.payloadHash).toBe(
      commandDigest({ a: [1, 2], nested: { a: null, b: true }, z: 3 }),
    );
    expect(command.connectionEpoch).toBe(1);
    await client.request("/health");
    expect(captured?.redirect).toBe("error");
    expect(new Headers(captured?.headers).get("x-agentdesk-remote-token")).toBe("x".repeat(32));
    await expect(client.request("/../../etc/passwd")).rejects.toThrow(
      "Invalid internal runner route",
    );
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteTaskInput, type ProjectGrant, type RemoteCommand } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { migrateRemoteDatabase } from "../src/db/remote-migrations";
import { EventHub } from "../src/events";
import { TaskService } from "../src/services/tasks";
import { TaskSubmissionService } from "../src/services/task-submissions";
import { payloadDigest } from "../src/services/remote/digest";
import { RemoteGrantStore } from "../src/services/remote/grants";
import { RemoteOperationStore } from "../src/services/remote/operations";
import { RemoteTaskSubmissionService } from "../src/services/remote/task-submissions";
import { readRemoteTask } from "../src/services/remote/task-contexts";
let handle: DbHandle;
const directories: string[] = [];
afterEach(() => {
  if (handle?.raw.open) handle.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const scope = {
  userId: "owner-1",
  hostId: "cloud",
  projectId: "project-1",
  workspaceId: "workspace-1",
};
function fixture() {
  handle = openDatabase(":memory:");
  const tasks = new TaskService(handle.db, new EventHub());
  return {
    tasks,
    submissions: new TaskSubmissionService(handle, tasks),
    operations: new RemoteOperationStore(handle.raw),
  };
}
function grant(): ProjectGrant {
  return {
    ...scope,
    capabilities: ["task.create", "git.push"],
    connectionEpoch: 1,
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    revokedAt: null,
  };
}
function command(payload: unknown): RemoteCommand {
  return {
    protocolVersion: 1,
    messageId: "message-1",
    requestId: "request-1",
    ...scope,
    actor: { userId: scope.userId, sessionId: "session-1", recentAuthAt: new Date().toISOString() },
    connectionEpoch: 1,
    action: "task.create",
    payloadHash: payloadDigest(payload),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
}
function count(table: string) {
  if (
    ![
      "documents",
      "runs",
      "remote_operations",
      "remote_task_contexts",
      "remote_audit_events",
    ].includes(table)
  )
    throw new Error("Invalid test table");
  return (
    handle.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
describe("完整任务请求事务", () => {
  it("重复请求只创建一个 Conversation／Task／Run，不同内容返回冲突", async () => {
    const { tasks, submissions } = fixture();
    const input = { goal: "Fix the test", idempotencyKey: "request-1" };
    const first = await submissions.submit(input);
    const replay = await submissions.submit(input);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.run.id).toBe(first.run.id);
    expect(await tasks.list()).toHaveLength(1);
    expect(count("documents")).toBe(2);
    expect(count("runs")).toBe(1);
    await expect(submissions.submit({ ...input, goal: "Different action" })).rejects.toThrow(
      /幂等键/,
    );
    expect(await tasks.list()).toHaveLength(1);
  });
  it("Run 创建失败时回滚会话和任务，重试可完整创建", async () => {
    const { tasks, submissions } = fixture();
    const spy = vi.spyOn(tasks, "createRun").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    await expect(submissions.submit({ goal: "Fix", idempotencyKey: "request-1" })).rejects.toThrow(
      "disk failure",
    );
    expect(count("documents")).toBe(0);
    expect(count("runs")).toBe(0);
    spy.mockRestore();
    expect((await submissions.submit({ goal: "Fix", idempotencyKey: "request-1" })).replayed).toBe(
      false,
    );
  });
  it("旧 Run 幂等键冲突不留下新的孤立 Task", async () => {
    const { tasks, submissions } = fixture();
    const task = await tasks.create({
      goal: "Legacy",
      conversationId: "legacy",
      requiresPlanApproval: false,
    });
    await tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      idempotencyKey: "legacy-key",
      input: { userMessage: "Legacy" },
    });
    await expect(
      submissions.submit({ goal: "New", idempotencyKey: "legacy-key" }),
    ).rejects.toThrow();
    expect(await tasks.list()).toHaveLength(1);
    expect(count("documents")).toBe(1);
  });
});
describe("权限范围与 lease", () => {
  it("拒绝跨宿主／项目／工作区／身份、内容篡改和未知能力", async () => {
    fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    const payload = { goal: "Fix" };
    const valid = command(payload);
    expect(await grants.authorize(valid, payload)).toEqual(valid);
    for (const field of ["hostId", "projectId", "workspaceId", "userId"] as const)
      await expect(grants.authorize({ ...valid, [field]: "other" }, payload)).rejects.toThrow();
    await expect(grants.authorize(valid, { goal: "Changed" })).rejects.toThrow(/摘要/);
    await expect(grants.authorize({ ...valid, action: "git.commit" }, payload)).rejects.toThrow(
      /权限/,
    );
  });
  it("撤销和新 epoch 使旧命令失效，不能用旧 epoch 恢复授权", async () => {
    fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    const valid = command({});
    await grants.revoke(scope);
    await expect(grants.authorize(valid, {})).rejects.toThrow();
    await expect(grants.put(grant())).rejects.toThrow(/epoch/);
    await grants.put({ ...grant(), connectionEpoch: 2 });
    await expect(grants.authorize(valid, {})).rejects.toThrow();
    expect(await grants.authorize({ ...valid, connectionEpoch: 2 }, {})).toBeTruthy();
  });
  it("过期命令和 lease、未来时间、缺少近期验证的 push 均拒绝", async () => {
    fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    const valid = command({});
    const now = Date.now();
    await expect(grants.authorize(valid, {}, now + 46000)).rejects.toThrow(/过期/);
    await expect(
      grants.authorize({ ...valid, issuedAt: new Date(now + 10000).toISOString() }, {}, now),
    ).rejects.toThrow();
    await expect(
      grants.authorize(
        {
          ...valid,
          action: "git.push",
          actor: { ...valid.actor, recentAuthAt: new Date(now - 16 * 60000).toISOString() },
        },
        {},
      ),
    ).rejects.toThrow(/近期/);
  });
});
describe("远程操作日志与原子任务", () => {
  it("规范化 JSON 不受属性顺序影响，不忽略数组顺序或非法数字", () => {
    expect(payloadDigest({ b: 2, a: [1, 3] })).toBe(payloadDigest({ a: [1, 3], b: 2 }));
    expect(payloadDigest([1, 2])).not.toBe(payloadDigest([2, 1]));
    expect(() => payloadDigest({ value: NaN })).toThrow();
  });
  it("幂等键按 user／host／project／action 隔离，工作区变更冲突", async () => {
    const { operations } = fixture();
    const first = await operations.accept(scope, "git.commit", "request-1", { files: ["a"] });
    expect(
      (await operations.accept(scope, "git.commit", "request-1", { files: ["a"] })).replayed,
    ).toBe(true);
    await expect(
      operations.accept(scope, "git.commit", "request-1", { files: ["b"] }),
    ).rejects.toThrow(/请求 ID/);
    await expect(
      operations.accept({ ...scope, workspaceId: "other" }, "git.commit", "request-1", {
        files: ["a"],
      }),
    ).rejects.toThrow();
    expect(
      (
        await operations.accept({ ...scope, projectId: "other" }, "git.commit", "request-1", {
          files: ["a"],
        })
      ).replayed,
    ).toBe(false);
    expect(
      await operations.get({ ...scope, userId: "other" }, first.operation.operationId),
    ).toBeUndefined();
  });
  it("外部动作中断后必须对账，不能回到 running 盲目重试", async () => {
    const { operations } = fixture();
    const { operation } = await operations.accept(scope, "git.commit", "request-1", {});
    const result = { beforeHead: "a", expectedTree: "b" };
    await operations.transition(scope, operation.operationId, "running", result);
    expect(await operations.reconcileInterrupted("cloud")).toBe(1);
    expect((await operations.get(scope, operation.operationId))?.status).toBe(
      "needs_reconciliation",
    );
    await expect(
      operations.transition(scope, operation.operationId, "running", result),
    ).rejects.toThrow();
    await operations.transition(scope, operation.operationId, "succeeded", { commit: "c" });
    expect(
      (await operations.accept(scope, "git.commit", "request-1", {})).operation.result,
    ).toEqual({
      commit: "c",
    });
    expect(count("remote_audit_events")).toBe(4);
  });
  it("完整资源图在一个事务内创建，重复提交不会调度第二次", async () => {
    const { tasks } = fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    const service = new RemoteTaskSubmissionService(
      handle,
      tasks,
      grants,
      async () => "/workspaces/project-1",
    );
    const payload = RemoteTaskInput.parse({
      clientRequestId: "request-1",
      goal: "Fix",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: scope.workspaceId,
    });
    const valid = command(payload);
    const [first, replay] = await Promise.all([
      await service.submit(valid, payload),
      await service.submit(valid, payload),
    ]);
    expect(replay.task.id).toBe(first.task.id);
    expect(count("remote_operations")).toBe(1);
    expect(count("remote_task_contexts")).toBe(1);
    expect(count("runs")).toBe(1);
    expect(first.run.executionOwner).toBe("local");
    expect((await readRemoteTask(handle.raw, first.task.id))?.executor).toBe("native-bot");
    await expect(tasks.enqueue(first.run.id)).rejects.toThrow(/重新验证/);
    const executor = vi.fn();
    new TaskService(handle.db, new EventHub(), { executor });
    expect(executor).not.toHaveBeenCalled();
    expect((await tasks.getRun(first.run.id))?.status).toBe("queued");
  });
  it("关联写入失败一并回滚操作、Task、Run 和审计", async () => {
    const { tasks } = fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    handle.raw.exec(
      "CREATE TRIGGER fail_context BEFORE INSERT ON remote_task_contexts BEGIN SELECT RAISE(ABORT, 'context failure'); END",
    );
    const service = new RemoteTaskSubmissionService(
      handle,
      tasks,
      grants,
      async () => "/workspaces/project-1",
    );
    const payload = RemoteTaskInput.parse({
      clientRequestId: "request-1",
      goal: "Fix",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: scope.workspaceId,
    });
    await expect(service.submit(command(payload), payload)).rejects.toThrow("context failure");
    for (const table of [
      "documents",
      "runs",
      "remote_operations",
      "remote_task_contexts",
      "remote_audit_events",
    ])
      expect(count(table)).toBe(0);
  });
  it("异步解析工作区期间撤销，不再创建任务", async () => {
    const { tasks } = fixture();
    const grants = new RemoteGrantStore(handle.raw, "cloud");
    await grants.put(grant());
    const service = new RemoteTaskSubmissionService(handle, tasks, grants, async () => {
      await grants.revoke(scope);
      return "/workspaces/project-1";
    });
    const payload = RemoteTaskInput.parse({
      clientRequestId: "request-1",
      goal: "Fix",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: scope.workspaceId,
    });
    await expect(service.submit(command(payload), payload)).rejects.toThrow();
    expect(count("remote_operations")).toBe(0);
  });
});
describe("前向迁移", () => {
  it("旧库数据保留，重复打开不重建迁移，未知 schema 拒绝启动", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdesk-remote-migration-"));
    directories.push(dir);
    const old = new Database(join(dir, "agentdesk.db"));
    old.exec("CREATE TABLE legacy_marker (value TEXT); INSERT INTO legacy_marker VALUES ('keep')");
    old.close();
    handle = openDatabase(dir);
    expect(handle.raw.prepare("SELECT value FROM legacy_marker").get()).toEqual({ value: "keep" });
    migrateRemoteDatabase(handle.raw);
    expect(handle.raw.prepare("SELECT count(*) AS n FROM remote_schema_migrations").get()).toEqual({
      n: 4,
    });
    handle.raw.prepare("INSERT INTO remote_schema_migrations VALUES (999,'unknown','now')").run();
    handle.close();
    expect(() => openDatabase(dir)).toThrow(/newer/);
  });
});

import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, StoragePolicy, httpStatusOf } from "@agentdesk/shared";
import { ZodError } from "zod";
import type { Container } from "../src/container";
import type { CloudConfig } from "../src/cloud-config";
import { remoteRoutes } from "../src/http/routes/remote";
import { openDatabase, type DbHandle } from "../src/db/client";
import { Collection } from "../src/db/collection";
import { EventHub } from "../src/events";
import { taskChannelToSse } from "../src/http/task-sse";
import { storageRoutes } from "../src/http/routes/storage";
import { TaskService } from "../src/services/tasks";
import { StorageService } from "../src/services/storage/service";
import { SqliteRetentionStore } from "../src/services/storage/sqlite-retention-store";
const volume = vi.hoisted(() => ({ free: 100 * 1024 ** 3, fail: false, calls: [] as string[] }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FsPromises>()),
  statfs: vi.fn(async (path: string) => {
    volume.calls.push(path);
    if (volume.fail) throw new Error("unavailable");
    return { bsize: 1, blocks: 200 * 1024 ** 3, bavail: volume.free };
  }),
}));
let handle: DbHandle;
let directory: string;
let storage: StorageService | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await storage?.dispose();
  storage = undefined;
  if (handle?.raw.open) handle.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  volume.free = 100 * 1024 ** 3;
  volume.fail = false;
  volume.calls = [];
});
async function fixture(persistent = false) {
  directory = await mkdtemp(join(tmpdir(), "agentdesk-storage-test-"));
  handle = openDatabase(persistent ? directory : ":memory:");
  const hub = new EventHub();
  const tasks = new TaskService(handle.db, hub);
  let busy = false;
  storage = new StorageService(
    handle.db,
    directory,
    tasks,
    new SqliteRetentionStore(handle.raw),
    () => busy,
  );
  const store = new Collection<Awaited<ReturnType<typeof tasks.create>>>(handle.db, "tasks");
  const old = new Date(Date.now() - 90 * 86400000);
  const closedTask = async () => {
    const task = await tasks.create({
      goal: "保留结果",
      conversationId: crypto.randomUUID(),
      requiresPlanApproval: false,
    });
    const run = await tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "code",
      trigger: "create",
      input: { userMessage: "test" },
    });
    await tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      event: { type: "text_delta", agent: "code", delta: "old" },
    });
    handle.raw
      .prepare("UPDATE runs SET status='succeeded',ended_at=? WHERE id=?")
      .run(old.toISOString(), run.id);
    handle.raw
      .prepare("UPDATE run_events SET created_at=? WHERE run_id=?")
      .run(old.toISOString(), run.id);
    store.update(task.id, (t) => ({ ...t, status: "closed", closedAt: old.toISOString() }));
    handle.raw
      .prepare("INSERT INTO traces(scope,event,created_at) VALUES(?,?,?)")
      .run(`chat:${task.conversationId}`, "{}", old.toISOString());
    return { task: (await tasks.get(task.id))!, run };
  };
  const oldFile = async (relative: string, content = "screenshot") => {
    const path = join(directory, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await utimes(path, old, old);
    return path;
  };
  return {
    tasks,
    hub,
    store,
    storage,
    oldFile,
    closedTask,
    busy: (value: boolean) => {
      busy = value;
    },
  };
}
describe("云宿主存储权限与清理", () => {
  const owner = {
    userId: "owner-1",
    sessionId: "session-1",
    recentAuthAt: new Date().toISOString(),
  };
  async function cloud(kind: "cloud" | "office" = "cloud") {
    const f = await fixture();
    const app = new Hono().route(
      "/remote",
      remoteRoutes({
        business: f.tasks.business,
        dbHandle: handle,
        storage: f.storage,
        cloudRunner: {},
        remoteGrants: {},
        remoteApprovals: {},
        shutdownSignal: new AbortController().signal,
        cloudConfig: {
          kind,
          hostId: kind,
          ownerUserId: owner.userId,
          remoteToken: "internal-test-token",
        },
      } as unknown as Container & {
        cloudConfig: CloudConfig;
      }),
    );
    app.onError((error, c) => {
      if (error instanceof AppError) return c.json(error.toBody(), httpStatusOf(error.code) as 400);
      if (error instanceof ZodError) return c.json({ error: "invalid" }, 400);
      throw error;
    });
    const call = (tail: string, body: unknown = { actor: owner }, token = "internal-test-token") =>
      app.request(`/remote/host/storage/${tail}`, {
        method: tail === "policy" ? "PUT" : "POST",
        headers: { "content-type": "application/json", "x-agentdesk-remote-token": token },
        body: JSON.stringify(body),
      });
    return { ...f, app, call };
  }
  it("内部 token 和 owner 双重校验，过期认证仍可读但不能修改", async () => {
    const f = await cloud();
    expect((await f.call("status", { actor: owner }, "forged")).status).toBe(401);
    expect((await f.call("status", { actor: { ...owner, userId: "member-1" } })).status).toBe(403);
    expect((await f.call("status")).status).toBe(200);
    const actor = { ...owner, recentAuthAt: new Date(Date.now() - 16 * 60000).toISOString() };
    expect((await f.call("status", { actor })).status).toBe(200);
    expect((await f.call("cleanup/preview", { actor })).status).toBe(401);
    expect((await f.call("policy", { actor, policy: StoragePolicy.parse({}) })).status).toBe(401);
    const health = await f.app.request("/remote/health", {
      headers: { "x-agentdesk-remote-token": "internal-test-token" },
    });
    expect((await health.json()).capabilities).toContain("storage.manage");
  });
  it("办公室宿主不提供全宿主存储权限或能力", async () => {
    const f = await cloud("office");
    expect((await f.call("status")).status).toBe(403);
    expect((await f.call("cleanup/preview")).status).toBe(403);
    const health = await f.app.request("/remote/health", {
      headers: { "x-agentdesk-remote-token": "internal-test-token" },
    });
    expect((await health.json()).capabilities).not.toContain("storage.manage");
  });
  it("策略持久化且拒绝额外路径，预览绑定会话并只能执行一次", async () => {
    const f = await cloud();
    const path = await f.oldFile("browser-shots/closed/cloud.png");
    const policy = StoragePolicy.parse({ screenshotDays: 10 });
    expect((await f.call("policy", { actor: owner, policy })).status).toBe(200);
    expect((await (await f.call("status")).json()).policy).toEqual(policy);
    expect(f.storage.policy()).toEqual(policy);
    const preview = await (await f.call("cleanup/preview")).json();
    expect(preview.files).toBe(1);
    expect(
      (
        await f.call("cleanup", {
          actor: { ...owner, sessionId: "other-session" },
          previewId: preview.id,
        })
      ).status,
    ).toBe(403);
    expect((await f.call("cleanup", { actor: owner, previewId: preview.id, path })).status).toBe(
      400,
    );
    expect((await stat(path)).isFile()).toBe(true);
    expect((await f.call("cleanup", { actor: owner, previewId: preview.id })).status).toBe(200);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.call("cleanup", { actor: owner, previewId: preview.id })).status).toBe(409);
  });
  it("并行登录会话的预览互不覆盖", async () => {
    const f = await fixture();
    const first = await f.storage.preview("session-a");
    const second = await f.storage.preview("session-b");
    await expect(f.storage.cleanup(first.id, "session-a")).resolves.toMatchObject({ files: 0 });
    await expect(f.storage.cleanup(second.id, "session-b")).resolves.toMatchObject({ files: 0 });
  });
});
describe("StorageService lifecycle", () => {
  it("按已关闭任务回收旧事件/轨迹，保留正文、成果、登录态和密钥", async () => {
    const f = await fixture();
    const { task, run } = await f.closedTask();
    const oldShot = await f.oldFile("browser-shots/closed/old.png");
    const profile = await f.oldFile("browser-profiles/p/Cookies", "private");
    const artifact = await f.oldFile("generated-artifacts/result.txt", "user-result");
    const key = await f.oldFile("dev-master.key", "synthetic-key");
    const referenced = await f.oldFile("browser-shots/closed/referenced.png");
    await f.tasks.recordArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "file",
      title: "证据",
      filePath: referenced,
    });
    const p = await f.storage.preview();
    expect(p).toMatchObject({ files: 1, events: 1, traces: 1 });
    const result = await f.storage.cleanup(p.id);
    expect(result).toMatchObject({ files: 1, events: 1, traces: 1, skipped: 0 });
    await expect(stat(oldShot)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [profile, artifact, key, referenced])
      expect((await readFile(path)).length).toBeGreaterThan(0);
    expect((await f.tasks.get(task.id))?.goal).toBe("保留结果");
    expect(await f.tasks.listArtifacts(task.id)).toHaveLength(1);
    await expect(f.tasks.eventsAfter({ taskId: task.id, after: 0, limit: 50 })).rejects.toThrow(
      /留存策略/,
    );
    const expired = (await f.tasks.expiredHistory({ runId: run.id }, 0))!;
    expect(expired.prunedThrough).toBeGreaterThan(0);
    expect(
      await f.tasks.eventsAfter({ runId: run.id, after: expired.prunedThrough, limit: 50 }),
    ).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ type: "artifact_ready" }) }),
    ]);
  });
  it("执行前重新检查订阅锁、任务状态与文件引用", async () => {
    const f = await fixture();
    const { task } = await f.closedTask();
    const path = await f.oldFile("browser-shots/s/race.png");
    const p = await f.storage.preview();
    const release = await f.tasks.pinEventHistory({ taskId: task.id });
    await f.tasks.recordArtifact({ taskId: task.id, kind: "file", title: "pin", filePath: path });
    expect(await f.storage.cleanup(p.id)).toMatchObject({
      files: 0,
      events: 0,
      traces: 0,
      skipped: 2,
    });
    release();
    expect((await f.storage.preview()).events).toBe(1);
  });
  it("异步回收持有维护锁时拒绝新订阅，完成后恢复订阅", async () => {
    const f = await fixture();
    const { task } = await f.closedTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const maintenance = f.tasks.withHistoryMaintenance(task.id, () => gate);
    await expect(f.tasks.pinEventHistory({ taskId: task.id })).rejects.toThrow(/维护/);
    release();
    await maintenance;
    const unpin = await f.tasks.pinEventHistory({ taskId: task.id });
    let called = false;
    await f.tasks.withHistoryMaintenance(task.id, async () => {
      called = true;
    });
    expect(called).toBe(false);
    unpin();
  });
  it("任务或浏览器会话活跃时跳过截图，待审批任务不回收历史", async () => {
    const f = await fixture();
    const { task } = await f.closedTask();
    await f.oldFile("browser-shots/s/old.png");
    f.busy(true);
    expect((await f.storage.preview()).files).toBe(0);
    f.busy(false);
    f.store.update(task.id, (t) => ({ ...t, status: "awaiting_plan_approval" }));
    expect(await f.storage.preview()).toMatchObject({ files: 0, events: 0, traces: 0 });
  });
  it("独立待审批记录保护已关闭任务，审批完成后才可回收", async () => {
    const f = await fixture();
    const { task } = await f.closedTask();
    const approvals = new Collection<{
      id: string;
      status: string;
      conversationId: string;
      payload: {
        taskId: string;
      };
    }>(handle.db, "approvals");
    approvals.put({
      id: "pending",
      status: "pending",
      conversationId: task.conversationId,
      payload: { taskId: task.id },
    });
    expect(await f.storage.preview()).toMatchObject({ events: 0, traces: 0 });
    approvals.update("pending", (a) => ({ ...a, status: "approved" }));
    expect(await f.storage.preview()).toMatchObject({ events: 1, traces: 1 });
  });
  it("大批历史分批回收，重启数据库后仍保留过期水位与任务结果", async () => {
    const f = await fixture(true);
    const { task, run } = await f.closedTask();
    const insert = handle.raw.prepare(
      "INSERT INTO run_events(task_id,run_id,parent_run_id,event,created_at) VALUES(?,?,NULL,?,?)",
    );
    handle.raw.transaction(() => {
      for (let i = 0; i < 1005; i++)
        insert.run(
          task.id,
          run.id,
          JSON.stringify({ type: "text_delta", agent: "code", delta: "history" }),
          "2020-01-01T00:00:00.000Z",
        );
    })();
    expect(await f.storage.preview()).toMatchObject({ events: 1000 });
    expect(await f.storage.cleanup((await f.storage.preview()).id)).toMatchObject({ events: 1000 });
    expect(await f.storage.preview()).toMatchObject({ events: 6 });
    expect(await f.storage.cleanup((await f.storage.preview()).id)).toMatchObject({ events: 6 });
    await f.storage.dispose();
    handle.close();
    handle = openDatabase(directory);
    const restarted = new TaskService(handle.db, new EventHub());
    expect((await restarted.expiredHistory({ taskId: task.id }, 0))?.prunedThrough).toBe(1006);
    expect((await restarted.get(task.id))?.goal).toBe("保留结果");
    expect(await restarted.eventsAfter({ taskId: task.id, after: 1006, limit: 50 })).toEqual([]);
  });
  it("磁盘准入检查失败时结束 Run，执行器不启动", async () => {
    await fixture();
    const executor = vi.fn();
    const tasks = new TaskService(handle.db, new EventHub(), {
      executor,
      beforeRun: async () => {
        throw new Error("storage unavailable");
      },
    });
    const task = await tasks.create({
      goal: "blocked",
      conversationId: crypto.randomUUID(),
      requiresPlanApproval: false,
    });
    const run = await tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "code",
      trigger: "create",
      input: { userMessage: "test" },
    });
    await tasks.enqueue(run.id);
    await vi.waitFor(async () => expect((await tasks.getRun(run.id))?.status).toBe("failed"));
    expect((await tasks.getRun(run.id))?.resultError).toContain("storage unavailable");
    expect(executor).not.toHaveBeenCalled();
    await tasks.shutdown();
  });
  it("预览过期、策略变化或重复执行时拒绝清理", async () => {
    const f = await fixture();
    const p = await f.storage.preview();
    f.storage.updatePolicy({ ...f.storage.policy(), eventDays: 60 });
    await expect(f.storage.cleanup(p.id)).rejects.toThrow(/失效/);
    const next = await f.storage.preview();
    vi.useFakeTimers();
    vi.advanceTimersByTime(300001);
    await expect(f.storage.cleanup(next.id)).rejects.toThrow(/失效/);
    vi.useRealTimers();
    const valid = await f.storage.preview();
    await f.storage.cleanup(valid.id);
    await expect(f.storage.cleanup(valid.id)).rejects.toThrow(/失效/);
  });
  it("不跟随目录链接，预览后修改文件不会被删除", async () => {
    const f = await fixture();
    const external = await f.oldFile("external/keep.png");
    await mkdir(join(directory, "browser-shots"));
    await symlink(join(directory, "external"), join(directory, "browser-shots/link"), "junction");
    const changed = await f.oldFile("browser-shots/real/change.png");
    const p = await f.storage.preview();
    expect(p.files).toBe(1);
    await writeFile(changed, "changed since preview");
    expect(await f.storage.cleanup(p.id)).toMatchObject({ files: 0, skipped: 1 });
    expect(await readFile(external, "utf8")).toBe("screenshot");
    expect((await f.storage.usage()).incomplete).toBe(true);
  });
  it("只扫描应用目录，并标注受保护与逻辑用量", async () => {
    const f = await fixture();
    await f.oldFile("generated-artifacts/a", "12345");
    await f.oldFile("browser-shots/s/a.png", "12");
    expect(await f.storage.usage()).toMatchObject({ totalBytes: 7, incomplete: false });
    expect((await f.storage.usage()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "generated-artifacts", bytes: 5, protected: true }),
        expect.objectContaining({ name: "browser-shots", bytes: 2, protected: false }),
      ]),
    );
  });
  it("分别检查数据目录和工作区，空间不足或无法检查时阻止新任务", async () => {
    const f = await fixture();
    await f.storage.assertWritable("workspace-test");
    expect(volume.calls).toEqual([directory, "workspace-test"]);
    volume.free = 9 * 1024 ** 3;
    await expect(f.storage.assertWritable()).rejects.toMatchObject({ code: "STORAGE_FULL" });
    volume.fail = true;
    await expect(f.storage.assertWritable()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("默认不开自动清理，启用后按小时清理", async () => {
    const f = await fixture();
    await f.closedTask();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    f.storage.start();
    await vi.advanceTimersByTimeAsync(3600000);
    expect((await f.storage.preview()).events).toBe(1);
    f.storage.updatePolicy({ ...f.storage.policy(), automaticCleanup: true });
    await vi.advanceTimersByTimeAsync(3600000);
    await vi.waitFor(() =>
      expect(handle.raw.prepare("SELECT count(*) AS n FROM run_events").get()).toMatchObject({
        n: 0,
      }),
    );
  });
  it("过期游标 SSE 明确终止，订阅 pin 最终被释放", async () => {
    const f = await fixture();
    const { task, run } = await f.closedTask();
    await f.storage.cleanup((await f.storage.preview()).id);
    const app = new Hono();
    app.get("/stream", (c) =>
      taskChannelToSse(c, f.hub, f.tasks, `run:${run.id}`, { runId: run.id }, 0, () => false),
    );
    const text = await (await app.request("/stream")).text();
    expect(text).toContain("event: history_expired");
    expect(text).toContain('"prunedThrough":');
    expect(f.tasks.isHistoryInUse(task.id)).toBe(false);
  });
  it("策略与清理接口校验，客户端不能指定任意删除路径", async () => {
    const f = await fixture();
    const app = new Hono().route("/api", storageRoutes(f.storage));
    app.onError((_e, c) => c.json({ error: "invalid" }, 400));
    expect(await (await app.request("/api/storage/policy")).json()).toEqual(
      StoragePolicy.parse({}),
    );
    expect(
      (
        await app.request("/api/storage/cleanup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previewId: crypto.randomUUID(), path: "C:/" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/storage/policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eventDays: -1 }),
        })
      ).status,
    ).toBe(400);
  });
});

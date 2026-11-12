import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DURABLE_EXECUTOR_VERSION, type DurableCheckpoint } from "@agentdesk/agent-core";
import type { Run, Task } from "@agentdesk/shared";
import { PostgresUnitOfWork } from "../src/db/postgres";
import { PostgresTaskPersistence } from "../src/services/storage/postgres-task-persistence";
const file = process.env.RUNNER_TEST_DATABASE_URL_FILE;
describe.skipIf(!file)("Runner PostgreSQL persistence", () => {
  const schema = `runner_test_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresUnitOfWork, store: PostgresTaskPersistence;
  beforeAll(async () => {
    db = await PostgresUnitOfWork.connect(readFileSync(file!, "utf8").trim(), schema);
    store = new PostgresTaskPersistence(db);
    await store.initialize();
  });
  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
  const checkpoint = (revision: number): DurableCheckpoint => ({
    schemaVersion: 1,
    executorVersion: DURABLE_EXECUTOR_VERSION,
    revision,
    agent: "code",
    phase: "model",
    turn: 0,
    messages: [],
    toolCalls: [],
    pendingCalls: [],
    nextToolIndex: 0,
    steps: {},
    allowedTools: null,
    text: "",
    providerId: null,
  });
  it("commits task, run and event together and rolls back across repositories", async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: "t",
      title: "t",
      goal: "goal",
      agent: "code",
      conversationId: "c",
      requiresPlanApproval: false,
      status: "pending",
      currentRunId: null,
      pendingApprovalId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    const run: Run = {
      id: "r",
      taskId: "t",
      parentRunId: null,
      kind: "root",
      agent: "code",
      status: "queued",
      trigger: "create",
      idempotencyKey: "request",
      executionOwner: "local",
      input: { userMessage: "goal" },
      resultText: null,
      resultError: null,
      toolCalls: null,
      cancelRequested: false,
      cancelRequestedAt: null,
      startedAt: null,
      endedAt: null,
      createdAt: now,
    };
    await expect(
      store.transaction(async () => {
        await store.tasks.put(task);
        await store.runs.insert(run);
        await store.events.append({
          taskId: "t",
          runId: "r",
          parentRunId: null,
          event: { type: "task_status", status: "queued" },
          createdAt: now,
        });
        throw new Error("rollback-probe");
      }),
    ).rejects.toThrow("rollback-probe");
    expect(await store.tasks.get("t")).toBeUndefined();
    expect(await store.runs.get("r")).toBeUndefined();
    expect(await store.events.read({ taskId: "t", after: 0, limit: 100 })).toEqual([]);
    await store.transaction(async () => {
      await store.tasks.put(task);
      await store.runs.insert(run);
    });
    expect(await store.runs.findByIdempotency("request")).toEqual(run);
    expect(await store.runs.activeForTasks(["t"])).toBe(true);
  });
  it("orders per-task event cursors by commit and supports restart replay", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const input = {
      taskId: "ordered",
      runId: "ordered-run",
      parentRunId: null,
      event: { type: "task_status" as const, status: "queued" as const },
      createdAt: new Date().toISOString(),
    };
    const first = store.transaction(async () => {
      const event = await store.events.append(input);
      entered();
      await gate;
      return event;
    });
    await ready;
    const second = store.events.append(input);
    expect(await store.events.read({ taskId: "ordered", after: 0, limit: 100 })).toEqual([]);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.seq > a.seq).toBe(true);
    const another = new PostgresTaskPersistence(db);
    expect(
      (await another.events.read({ taskId: "ordered", after: a.seq, limit: 100 })).map(
        (row) => row.seq,
      ),
    ).toEqual([b.seq]);
  });
  it("fences old epochs, races checkpoint revisions safely and preserves stop intent", async () => {
    const epoch = await store.checkpoints.acquireEpoch();
    const attempts = await Promise.allSettled([
      store.checkpoints.save("checkpoint", epoch, checkpoint(1)),
      store.checkpoints.save("checkpoint", epoch, checkpoint(1)),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.checkpoints.load("checkpoint"))!.checkpoint.revision).toBe(1);
    const nextEpoch = await store.checkpoints.acquireEpoch();
    await expect(store.checkpoints.save("checkpoint", epoch, checkpoint(2))).rejects.toThrow();
    await store.checkpoints.save("checkpoint", nextEpoch, checkpoint(2));
    await store.checkpoints.stop("checkpoint");
    await expect(store.checkpoints.save("checkpoint", nextEpoch, checkpoint(3))).rejects.toThrow();
  });
});

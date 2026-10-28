import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { runs } from "../src/db/schema";
import { EventHub } from "../src/events";
import {
  TaskService,
  type RunExecutor,
  type RunOutcome,
  type TaskServiceOptions,
} from "../src/services/tasks";

let handle: DbHandle | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
});

function createTaskService(options?: TaskServiceOptions): TaskService {
  handle = openDatabase(":memory:");
  return new TaskService(handle.db, new EventHub(), options);
}

function makeTaskWithRun(tasks: TaskService, label: string) {
  const task = tasks.create({
    goal: label,
    conversationId: `conv-${label}`,
    requiresPlanApproval: false,
  });
  const run = tasks.createRun({
    taskId: task.id,
    kind: "root",
    agent: "orchestrator",
    trigger: "create",
    input: { userMessage: label },
  });
  tasks.transition(task.id, "queued");
  return { task, run };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("TaskService 并发队列", () => {
  it("并发槛位限制：按入队顺序领取，任意时刻运行数不超过上限", async () => {
    const deferred = new Map<string, (outcome: RunOutcome) => void>();
    const executor: RunExecutor = (run) =>
      new Promise<RunOutcome>((resolve) => {
        deferred.set(run.id, resolve);
      });
    const tasks = createTaskService({ maxConcurrentRuns: 2, executor });

    const r1 = makeTaskWithRun(tasks, "r1");
    const r2 = makeTaskWithRun(tasks, "r2");
    const r3 = makeTaskWithRun(tasks, "r3");
    const r4 = makeTaskWithRun(tasks, "r4");

    tasks.enqueue(r1.run.id);
    tasks.enqueue(r2.run.id);
    tasks.enqueue(r3.run.id);
    tasks.enqueue(r4.run.id);

    // 槛位为 2：前两个立刻进入 running，第 3、4 个必须留在 queued
    expect(tasks.getRun(r1.run.id)!.status).toBe("running");
    expect(tasks.getRun(r2.run.id)!.status).toBe("running");
    expect(tasks.getRun(r3.run.id)!.status).toBe("queued");
    expect(tasks.getRun(r4.run.id)!.status).toBe("queued");

    // 第 1 个结束后，按入队顺序应该是第 3 个（不是第 4 个）补上
    deferred.get(r1.run.id)!({ status: "succeeded" });
    await waitFor(() => tasks.getRun(r3.run.id)!.status === "running");
    expect(tasks.getRun(r1.run.id)!.status).toBe("succeeded");
    expect(tasks.getRun(r2.run.id)!.status).toBe("running");
    expect(tasks.getRun(r4.run.id)!.status).toBe("queued");

    deferred.get(r2.run.id)!({ status: "succeeded" });
    deferred.get(r3.run.id)!({ status: "succeeded" });
    await waitFor(() => tasks.getRun(r4.run.id)!.status === "running");
    deferred.get(r4.run.id)!({ status: "succeeded" });
    await waitFor(() => tasks.getRun(r4.run.id)!.status === "succeeded");
  });

  it("取消排队中的 Run：领取时直接变成 cancelled，不会真正执行", async () => {
    const executed = new Set<string>();
    const deferred = new Map<string, (outcome: RunOutcome) => void>();
    const executor: RunExecutor = (run) =>
      new Promise<RunOutcome>((resolve) => {
        executed.add(run.id);
        deferred.set(run.id, resolve);
      });
    const tasks = createTaskService({ maxConcurrentRuns: 1, executor });

    const a = makeTaskWithRun(tasks, "a");
    const b = makeTaskWithRun(tasks, "b");
    tasks.enqueue(a.run.id);
    tasks.enqueue(b.run.id);

    expect(tasks.getRun(a.run.id)!.status).toBe("running");
    expect(tasks.getRun(b.run.id)!.status).toBe("queued");

    tasks.requestCancel(b.run.id);
    expect(tasks.getRun(b.run.id)!.cancelRequested).toBe(true);

    deferred.get(a.run.id)!({ status: "succeeded" });
    await waitFor(() => tasks.getRun(b.run.id)!.status === "cancelled");

    expect(executed.has(b.run.id)).toBe(false);
  });

  it("取消正在执行的 Run：abort signal 触发，最终落地为 cancelled", async () => {
    let capturedSignal: AbortSignal | undefined;
    const executor: RunExecutor = (_run, _task, signal) => {
      capturedSignal = signal;
      return new Promise<RunOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("已中止")));
      });
    };
    const tasks = createTaskService({ maxConcurrentRuns: 1, executor });

    const a = makeTaskWithRun(tasks, "a");
    tasks.enqueue(a.run.id);
    expect(tasks.getRun(a.run.id)!.status).toBe("running");

    const cancelled = tasks.requestCancel(a.run.id);
    expect(cancelled.cancelRequested).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    await waitFor(() => tasks.getRun(a.run.id)!.status === "cancelled");
  });
});

describe("TaskService 重启恢复", () => {
  it("崩溃前 running 的 Run 恢复为 failed，任务同步失败", async () => {
    const hub = new EventHub();
    const tasks = createTaskService();

    const task = tasks.create({
      goal: "重启恢复测试",
      conversationId: "conv-restart-running",
      requiresPlanApproval: false,
    });
    const run = tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      input: { userMessage: "重启恢复测试" },
    });
    tasks.transition(task.id, "queued");
    tasks.transition(task.id, "running");
    // 模拟进程崩溃前正在执行：直接改库，不经过 enqueue/pump，
    // 这样新实例的内存态（runningSet/controllers）里不会有这条 run。
    handle!.db
      .update(runs)
      .set({ status: "running", startedAt: new Date().toISOString() })
      .where(eq(runs.id, run.id))
      .run();

    const restarted = new TaskService(handle!.db, hub);

    const recoveredRun = restarted.getRun(run.id)!;
    expect(recoveredRun.status).toBe("failed");
    expect(recoveredRun.resultError).toContain("重启");

    const recoveredTask = restarted.get(task.id)!;
    expect(recoveredTask.status).toBe("failed");
  });

  it("崩溃前 queued 的 Run 重新入队并正常执行完成", async () => {
    const hub = new EventHub();
    const tasks = createTaskService();

    const task = tasks.create({
      goal: "重启恢复测试二",
      conversationId: "conv-restart-queued",
      requiresPlanApproval: false,
    });
    const runId = "run-restart-queued";
    const now = new Date().toISOString();
    // 不经过 createRun + enqueue，直接插库模拟"崩溃前已经创建但还没被领取"。
    handle!.db
      .insert(runs)
      .values({
        id: runId,
        taskId: task.id,
        parentRunId: null,
        kind: "root",
        agent: "orchestrator",
        status: "queued",
        trigger: "create",
        idempotencyKey: null,
        input: { userMessage: "崩溃前已创建但未领取" },
        resultText: null,
        resultError: null,
        toolCalls: null,
        cancelRequested: false,
        cancelRequestedAt: null,
        startedAt: null,
        endedAt: null,
        createdAt: now,
      })
      .run();

    const restarted = new TaskService(handle!.db, hub);
    await waitFor(() => restarted.getRun(runId)!.status === "succeeded");
    expect(restarted.getRun(runId)!.resultText).toContain("占位执行完成");
  });
});

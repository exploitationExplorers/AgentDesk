import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import type { Task } from "@agentdesk/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { createApp } from "../src/http/app";
import { acquireConversation } from "../src/services/conversation-activity";
import { TaskService, type CreateRunInput } from "../src/services/tasks";

let handle: DbHandle | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
  vi.restoreAllMocks();
});
const createService = () => {
  handle = openDatabase(":memory:");
  return new TaskService(handle.db, new EventHub());
};
const input = (taskId: string, trigger: CreateRunInput["trigger"] = "create"): CreateRunInput => ({
  taskId,
  kind: "root",
  agent: "code",
  trigger,
  input: { userMessage: "继续任务" },
});

describe("根 Run 创建前的会话互斥", () => {
  it.each(["queued", "running"] as const)(
    "已有 %s Run 时拒绝额外根 Run，原任务和 currentRunId 不变",
    (status) => {
      const tasks = createService();
      const task = tasks.create({
        goal: "原任务",
        conversationId: `busy-${status}`,
        requiresPlanApproval: false,
      });
      const run = tasks.createRun(input(task.id));
      if (status === "running") tasks.startRunDirect(run.id);
      const before = tasks.get(task.id);
      expect(() => tasks.createRun(input(task.id, "followup"))).toThrow(/排队或执行中/);
      expect(tasks.get(task.id)).toEqual(before);
      expect(tasks.listRuns(task.id)).toHaveLength(1);
      expect(tasks.getRun(run.id)?.status).toBe(status);
      // 同一会话即使使用另一个 Task，也不能绕过活动 Run。
      const another = tasks.create({
        goal: "另一个任务",
        conversationId: task.conversationId,
        requiresPlanApproval: false,
      });
      expect(() => tasks.createRun(input(another.id))).toThrow(/排队或执行中/);
      expect(tasks.get(another.id)?.currentRunId).toBeNull();
      expect(tasks.listRuns(another.id)).toEqual([]);
    },
  );

  it.each(["running", "compacting"] as const)("已有 %s 活动锁时根 Run 在落库前拒绝", (activity) => {
    const tasks = createService();
    const task = tasks.create({
      goal: "锁测试",
      conversationId: `locked-${activity}`,
      requiresPlanApproval: false,
    });
    const release = acquireConversation(task.conversationId, activity);
    try {
      expect(() => tasks.createRun(input(task.id))).toThrow(/执行或压缩/);
      expect(tasks.get(task.id)).toEqual(task);
      expect(tasks.listRuns(task.id)).toEqual([]);
      if (activity === "compacting")
        expect(() => tasks.createRun({ ...input(task.id), conversationLockHeld: true })).toThrow(
          /执行或压缩/,
        );
    } finally {
      release();
    }
  });

  it("聊天内部持锁创建允许首个根 Run，但持锁声明不绕过已有 Run", () => {
    const tasks = createService();
    const task = tasks.create({
      goal: "聊天",
      conversationId: "chat-owned-lock",
      requiresPlanApproval: false,
    });
    const release = acquireConversation(task.conversationId, "running");
    try {
      const run = tasks.createRun({ ...input(task.id), conversationLockHeld: true });
      tasks.startRunDirect(run.id);
      expect(tasks.get(task.id)).toMatchObject({ status: "running", currentRunId: run.id });
      expect(() =>
        tasks.createRun({ ...input(task.id, "followup"), conversationLockHeld: true }),
      ).toThrow(/排队或执行中/);
      expect(tasks.listRuns(task.id)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("执行中的根 Run 可以创建委派子 Run，子 Run 不接管 currentRunId", () => {
    const tasks = createService();
    const task = tasks.create({
      goal: "委派",
      conversationId: "delegate-lock",
      requiresPlanApproval: false,
    });
    const root = tasks.createRun(input(task.id));
    tasks.startRunDirect(root.id);
    const release = acquireConversation(task.conversationId, "running");
    try {
      const child = tasks.createRun({
        ...input(task.id, "delegate"),
        kind: "delegate",
        parentRunId: root.id,
      });
      tasks.startRunDirect(child.id);
      expect(tasks.get(task.id)).toMatchObject({ status: "running", currentRunId: root.id });
      expect(tasks.getRun(child.id)).toMatchObject({
        kind: "delegate",
        status: "running",
        parentRunId: root.id,
      });
    } finally {
      release();
    }
  });

  it("幂等重复请求返回原活动 Run，不产生新运行或串用其他 Task 的幂等键", () => {
    const tasks = createService();
    const task = tasks.create({
      goal: "幂等",
      conversationId: "idempotent-lock",
      requiresPlanApproval: false,
    });
    const request = { ...input(task.id), idempotencyKey: "root-key" };
    const root = tasks.createRun(request);
    tasks.startRunDirect(root.id);
    const release = acquireConversation(task.conversationId, "running");
    try {
      expect(tasks.createRun(request).id).toBe(root.id);
      expect(tasks.listRuns(task.id)).toHaveLength(1);
      const other = tasks.create({
        goal: "另一任务",
        conversationId: "other-key",
        requiresPlanApproval: false,
      });
      expect(() => tasks.createRun({ ...request, taskId: other.id })).toThrow(/幂等键/);
      expect(tasks.listRuns(other.id)).toEqual([]);
    } finally {
      release();
    }
  });

  it("资料分析只允许首个 create，完成后不能以任何根 Run 触发方式续跑", () => {
    const tasks = createService();
    const task = tasks.create({
      goal: "资料",
      conversationId: "reference-purpose",
      requiresPlanApproval: false,
      purpose: "reference_analysis",
    });
    expect(() => tasks.createRun(input(task.id, "continue"))).toThrow(/资料分析不能直接续跑/);
    const root = tasks.createRun(input(task.id));
    tasks.startRunDirect(root.id);
    tasks.finalizeRunDirect(root.id, { status: "succeeded", resultText: "只读分析完成" });
    const before = tasks.get(task.id);
    for (const trigger of ["create", "continue", "followup", "resume", "delegate"] as const)
      expect(() => tasks.createRun(input(task.id, trigger))).toThrow(/资料分析不能直接续跑/);
    expect(tasks.get(task.id)).toEqual(before);
    expect(tasks.listRuns(task.id)).toHaveLength(1);
  });
});

describe("并发续跑 HTTP 拒绝不影响原执行", () => {
  let container: Container;
  let faux: FauxProviderRegistration;
  beforeAll(async () => {
    container = await createContainer(
      {
        ...loadConfig({
          AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-run-conflict-")),
        }),
        token: "concurrency-test",
      },
      { inMemory: true },
    );
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    container.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
    ];
  });
  afterAll(async () => {
    await container.dispose();
    faux.unregister();
  });
  const call = (path: string, body: unknown) =>
    createApp(container).request(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "concurrency-test" },
      body: JSON.stringify(body),
    });

  it("原请求挂起时续跑返回 409，原 Run 完成后任务仍正常进入 awaiting_review", async () => {
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.spyOn(container.orchestrator, "run").mockImplementation(async () => {
      await released;
      return { text: "原执行完成", agent: "code", toolCalls: [] };
    });
    const created = await call("/tasks", { goal: "等待后完成" });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const before = container.tasks.get(task.id)!;
      const originalRun = container.tasks.getRun(before.currentRunId!)!;
      const followup = await call(`/tasks/${task.id}/runs`, {
        trigger: "followup",
        message: "并发追加",
      });
      expect(followup.status).toBe(409);
      expect(container.tasks.get(task.id)).toEqual(before);
      expect(container.tasks.listRuns(task.id)).toHaveLength(1);
      expect(container.tasks.getRun(originalRun.id)?.status).toBe("running");
      const taskCount = container.tasks.list().length;
      expect(
        (await call("/tasks", { goal: "同会话另建任务", conversationId: task.conversationId }))
          .status,
      ).toBe(409);
      expect(container.tasks.list()).toHaveLength(taskCount);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      finish();
    }
    await vi.waitFor(() => expect(container.tasks.get(task.id)?.status).toBe("awaiting_review"));
    expect(container.tasks.getRun(container.tasks.get(task.id)!.currentRunId!)?.resultText).toBe(
      "原执行完成",
    );
  });

  it("排队中和压缩中的任务拒绝续跑，不更改任务或写入新 Run", async () => {
    for (const activity of ["queued", "compacting"] as const) {
      const task = container.tasks.create({
        goal: activity,
        conversationId: `api-${activity}`,
        requiresPlanApproval: false,
      });
      if (activity === "queued") container.tasks.createRun(input(task.id));
      const release =
        activity === "compacting"
          ? acquireConversation(task.conversationId, "compacting")
          : () => {};
      try {
        const before = container.tasks.get(task.id);
        const runCount = container.tasks.listRuns(task.id).length;
        const response = await call(`/tasks/${task.id}/runs`, {
          trigger: "followup",
          message: "追加",
        });
        expect(response.status).toBe(409);
        expect(container.tasks.get(task.id)).toEqual(before);
        expect(container.tasks.listRuns(task.id)).toHaveLength(runCount);
      } finally {
        release();
      }
    }
  });
});

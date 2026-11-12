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
    async (status) => {
      const tasks = createService();
      const task = await tasks.create({
        goal: "原任务",
        conversationId: `busy-${status}`,
        requiresPlanApproval: false,
      });
      const run = await tasks.createRun(input(task.id));
      if (status === "running") await tasks.startRunDirect(run.id);
      const before = await tasks.get(task.id);
      await expect(tasks.createRun(input(task.id, "followup"))).rejects.toThrow(/排队或执行中/);
      expect(await tasks.get(task.id)).toEqual(before);
      expect(await tasks.listRuns(task.id)).toHaveLength(1);
      expect((await tasks.getRun(run.id))?.status).toBe(status);
      // 同一会话即使使用另一个 Task，也不能绕过活动 Run。
      const another = await tasks.create({
        goal: "另一个任务",
        conversationId: task.conversationId,
        requiresPlanApproval: false,
      });
      await expect(tasks.createRun(input(another.id))).rejects.toThrow(/排队或执行中/);
      expect((await tasks.get(another.id))?.currentRunId).toBeNull();
      expect(await tasks.listRuns(another.id)).toEqual([]);
    },
  );
  it.each(["running", "compacting"] as const)(
    "已有 %s 活动锁时根 Run 在落库前拒绝",
    async (activity) => {
      const tasks = createService();
      const task = await tasks.create({
        goal: "锁测试",
        conversationId: `locked-${activity}`,
        requiresPlanApproval: false,
      });
      const release = acquireConversation(task.conversationId, activity);
      try {
        await expect(tasks.createRun(input(task.id))).rejects.toThrow(/执行或压缩/);
        expect(await tasks.get(task.id)).toEqual(task);
        expect(await tasks.listRuns(task.id)).toEqual([]);
        if (activity === "compacting")
          await expect(
            tasks.createRun({ ...input(task.id), conversationLockHeld: true }),
          ).rejects.toThrow(/执行或压缩/);
      } finally {
        release();
      }
    },
  );
  it("聊天内部持锁创建允许首个根 Run，但持锁声明不绕过已有 Run", async () => {
    const tasks = createService();
    const task = await tasks.create({
      goal: "聊天",
      conversationId: "chat-owned-lock",
      requiresPlanApproval: false,
    });
    const release = acquireConversation(task.conversationId, "running");
    try {
      const run = await tasks.createRun({ ...input(task.id), conversationLockHeld: true });
      await tasks.startRunDirect(run.id);
      expect(await tasks.get(task.id)).toMatchObject({ status: "running", currentRunId: run.id });
      await expect(
        tasks.createRun({ ...input(task.id, "followup"), conversationLockHeld: true }),
      ).rejects.toThrow(/排队或执行中/);
      expect(await tasks.listRuns(task.id)).toHaveLength(1);
    } finally {
      release();
    }
  });
  it("执行中的根 Run 可以创建委派子 Run，子 Run 不接管 currentRunId", async () => {
    const tasks = createService();
    const task = await tasks.create({
      goal: "委派",
      conversationId: "delegate-lock",
      requiresPlanApproval: false,
    });
    const root = await tasks.createRun(input(task.id));
    await tasks.startRunDirect(root.id);
    const release = acquireConversation(task.conversationId, "running");
    try {
      const child = await tasks.createRun({
        ...input(task.id, "delegate"),
        kind: "delegate",
        parentRunId: root.id,
      });
      await tasks.startRunDirect(child.id);
      expect(await tasks.get(task.id)).toMatchObject({ status: "running", currentRunId: root.id });
      expect(await tasks.getRun(child.id)).toMatchObject({
        kind: "delegate",
        status: "running",
        parentRunId: root.id,
      });
    } finally {
      release();
    }
  });
  it("幂等重复请求返回原活动 Run，不产生新运行或串用其他 Task 的幂等键", async () => {
    const tasks = createService();
    const task = await tasks.create({
      goal: "幂等",
      conversationId: "idempotent-lock",
      requiresPlanApproval: false,
    });
    const request = { ...input(task.id), idempotencyKey: "root-key" };
    const root = await tasks.createRun(request);
    await tasks.startRunDirect(root.id);
    const release = acquireConversation(task.conversationId, "running");
    try {
      expect((await tasks.createRun(request)).id).toBe(root.id);
      expect(await tasks.listRuns(task.id)).toHaveLength(1);
      const other = await tasks.create({
        goal: "另一任务",
        conversationId: "other-key",
        requiresPlanApproval: false,
      });
      await expect(tasks.createRun({ ...request, taskId: other.id })).rejects.toThrow(/幂等键/);
      expect(await tasks.listRuns(other.id)).toEqual([]);
    } finally {
      release();
    }
  });
  it("资料分析只允许首个 create，完成后不能以任何根 Run 触发方式续跑", async () => {
    const tasks = createService();
    const task = await tasks.create({
      goal: "资料",
      conversationId: "reference-purpose",
      requiresPlanApproval: false,
      purpose: "reference_analysis",
    });
    await expect(tasks.createRun(input(task.id, "continue"))).rejects.toThrow(
      /资料分析不能直接续跑/,
    );
    const root = await tasks.createRun(input(task.id));
    await tasks.startRunDirect(root.id);
    await tasks.finalizeRunDirect(root.id, { status: "succeeded", resultText: "只读分析完成" });
    const before = await tasks.get(task.id);
    for (const trigger of ["create", "continue", "followup", "resume", "delegate"] as const)
      await expect(tasks.createRun(input(task.id, trigger))).rejects.toThrow(
        /资料分析不能直接续跑/,
      );
    expect(await tasks.get(task.id)).toEqual(before);
    expect(await tasks.listRuns(task.id)).toHaveLength(1);
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
      return { status: "completed", text: "原执行完成", agent: "code", toolCalls: [] };
    });
    const created = await call("/tasks", { goal: "等待后完成" });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const before = (await container.tasks.get(task.id))!;
      const originalRun = (await container.tasks.getRun(before.currentRunId!))!;
      const followup = await call(`/tasks/${task.id}/runs`, {
        trigger: "followup",
        message: "并发追加",
      });
      expect(followup.status).toBe(409);
      expect(await container.tasks.get(task.id)).toEqual(before);
      expect(await container.tasks.listRuns(task.id)).toHaveLength(1);
      expect((await container.tasks.getRun(originalRun.id))?.status).toBe("running");
      const taskCount = (await container.tasks.list()).length;
      expect(
        (await call("/tasks", { goal: "同会话另建任务", conversationId: task.conversationId }))
          .status,
      ).toBe(409);
      expect(await container.tasks.list()).toHaveLength(taskCount);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      finish();
    }
    await vi.waitFor(async () =>
      expect((await container.tasks.get(task.id))?.status).toBe("awaiting_review"),
    );
    expect(
      (await container.tasks.getRun((await container.tasks.get(task.id))!.currentRunId!))
        ?.resultText,
    ).toBe("原执行完成");
  });
  it("排队中和压缩中的任务拒绝续跑，不更改任务或写入新 Run", async () => {
    for (const activity of ["queued", "compacting"] as const) {
      const task = await container.tasks.create({
        goal: activity,
        conversationId: `api-${activity}`,
        requiresPlanApproval: false,
      });
      if (activity === "queued") await container.tasks.createRun(input(task.id));
      const release =
        activity === "compacting"
          ? acquireConversation(task.conversationId, "compacting")
          : () => {};
      try {
        const before = await container.tasks.get(task.id);
        const runCount = (await container.tasks.listRuns(task.id)).length;
        const response = await call(`/tasks/${task.id}/runs`, {
          trigger: "followup",
          message: "追加",
        });
        expect(response.status).toBe(409);
        expect(await container.tasks.get(task.id)).toEqual(before);
        expect(await container.tasks.listRuns(task.id)).toHaveLength(runCount);
      } finally {
        release();
      }
    }
  });
});

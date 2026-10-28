import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { TaskService } from "../src/services/tasks";

let handle: DbHandle | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
});

function createTaskService(): TaskService {
  handle = openDatabase(":memory:");
  return new TaskService(handle.db, new EventHub());
}

describe("TaskService 状态机", () => {
  it("合法迁移全部走通", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "修复登录页报错",
      conversationId: "c1",
      requiresPlanApproval: true,
    });

    expect(tasks.transition(task.id, "queued").status).toBe("queued");
    expect(tasks.transition(task.id, "planning").status).toBe("planning");
    expect(tasks.transition(task.id, "awaiting_plan_approval").status).toBe(
      "awaiting_plan_approval",
    );
    expect(tasks.transition(task.id, "running").status).toBe("running");
    expect(tasks.transition(task.id, "awaiting_review").status).toBe("awaiting_review");
    expect(tasks.transition(task.id, "completed").status).toBe("completed");
    expect(tasks.transition(task.id, "closed").status).toBe("closed");
  });

  it("failed 和 cancelled 可以回到 queued 或 closed", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "部署到生产",
      conversationId: "c2",
      requiresPlanApproval: false,
    });
    tasks.transition(task.id, "queued");
    tasks.transition(task.id, "running");
    tasks.transition(task.id, "failed");
    expect(tasks.transition(task.id, "queued").status).toBe("queued");
    tasks.transition(task.id, "running");
    tasks.transition(task.id, "failed");
    expect(tasks.transition(task.id, "closed").status).toBe("closed");
  });

  it("非法迁移抛错：pending 不能直接跳到 running", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "直接执行",
      conversationId: "c3",
      requiresPlanApproval: false,
    });
    expect(() => tasks.transition(task.id, "running")).toThrow();
  });

  it("非法迁移抛错：closed 之后不能再迁移", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "已完成的任务",
      conversationId: "c4",
      requiresPlanApproval: false,
    });
    tasks.transition(task.id, "queued");
    tasks.transition(task.id, "running");
    tasks.transition(task.id, "awaiting_review");
    tasks.transition(task.id, "completed");
    tasks.transition(task.id, "closed");
    expect(() => tasks.transition(task.id, "queued")).toThrow();
  });
});

describe("TaskService.create", () => {
  it("初始状态为 pending，goal 过长时 title 截断到 40 字", () => {
    const tasks = createTaskService();
    const goal = "一".repeat(60);
    const task = tasks.create({ goal, conversationId: "c5", requiresPlanApproval: false });
    expect(task.status).toBe("pending");
    expect(task.title).toBe(goal.slice(0, 40));
    expect(task.title.length).toBe(40);
  });

  it("显式传入 title 时优先使用", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      title: "自定义标题",
      goal: "任意目标",
      conversationId: "c6",
      requiresPlanApproval: false,
    });
    expect(task.title).toBe("自定义标题");
  });
});

describe("TaskService.createRun 幂等性", () => {
  it("相同 idempotencyKey 调用两次只产生一条 run，返回同一个 id", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "幂等测试",
      conversationId: "c7",
      requiresPlanApproval: false,
    });
    const first = tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      idempotencyKey: "key-1",
      input: { userMessage: "开始" },
    });
    const second = tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      idempotencyKey: "key-1",
      input: { userMessage: "开始" },
    });
    expect(second.id).toBe(first.id);
    expect(tasks.listRuns(task.id)).toHaveLength(1);
  });

  it("不带 idempotencyKey 多次调用，每次都产生新行", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "无幂等键测试",
      conversationId: "c8",
      requiresPlanApproval: false,
    });
    tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      input: { userMessage: "第一次" },
    });
    tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "continue",
      input: { userMessage: "第二次" },
    });
    expect(tasks.listRuns(task.id)).toHaveLength(2);
  });
});

describe("TaskService.recordArtifact 版本管理", () => {
  it("同一 (taskId, kind) 连续调用三次，version 依次是 1、2、3", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "产物版本测试",
      conversationId: "c9",
      requiresPlanApproval: false,
    });
    const v1 = tasks.recordArtifact({ taskId: task.id, kind: "plan", title: "方案 v1" });
    const v2 = tasks.recordArtifact({ taskId: task.id, kind: "plan", title: "方案 v2" });
    const v3 = tasks.recordArtifact({ taskId: task.id, kind: "plan", title: "方案 v3" });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it("不同 kind 各自独立计数", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "多类型产物测试",
      conversationId: "c10",
      requiresPlanApproval: false,
    });
    tasks.recordArtifact({ taskId: task.id, kind: "plan", title: "方案 v1" });
    const change1 = tasks.recordArtifact({ taskId: task.id, kind: "change", title: "变更 v1" });
    expect(change1.version).toBe(1);
  });

  it("latestArtifact 返回版本号最大的那条", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "最新产物测试",
      conversationId: "c11",
      requiresPlanApproval: false,
    });
    tasks.recordArtifact({ taskId: task.id, kind: "summary", title: "总结 v1" });
    tasks.recordArtifact({ taskId: task.id, kind: "summary", title: "总结 v2" });
    const latest = tasks.recordArtifact({ taskId: task.id, kind: "summary", title: "总结 v3" });
    expect(tasks.latestArtifact(task.id, "summary")).toEqual(latest);
  });
});

describe("TaskService.close 归档", () => {
  it("终态（completed/failed/cancelled）可以关闭，closedAt 被写入", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "归档测试",
      conversationId: "c12",
      requiresPlanApproval: false,
    });
    tasks.transition(task.id, "queued");
    tasks.transition(task.id, "running");
    tasks.transition(task.id, "failed");

    const closed = tasks.close(task.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
  });

  it("再次关闭已关闭的任务是幂等的，不报错", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "幂等归档测试",
      conversationId: "c13",
      requiresPlanApproval: false,
    });
    tasks.transition(task.id, "queued");
    tasks.transition(task.id, "running");
    tasks.transition(task.id, "cancelled");
    tasks.close(task.id);

    expect(() => tasks.close(task.id)).not.toThrow();
    expect(tasks.close(task.id).status).toBe("closed");
  });

  it("非终态任务不能关闭，抛出明确错误", () => {
    const tasks = createTaskService();
    const task = tasks.create({
      goal: "非终态归档测试",
      conversationId: "c14",
      requiresPlanApproval: false,
    });
    tasks.transition(task.id, "queued");

    expect(() => tasks.close(task.id)).toThrow(/不是终态/);
  });
});

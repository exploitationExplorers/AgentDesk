import { afterEach, expect, it } from "vitest";
import type { TaskStreamEvent } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { ApprovalService } from "../src/services/approvals";
import { readRunToolHistory, summarizeToolCalls } from "../src/services/run-tool-history";
import { createDelegateHandler } from "../src/services/task-executor";
import { TaskService } from "../src/services/tasks";

let database: DbHandle | undefined;
afterEach(() => database?.close());

function setup() {
  database = openDatabase(":memory:");
  const hub = new EventHub();
  const tasks = new TaskService(database.db, hub);
  const task = tasks.create({
    goal: "恢复工具记录",
    conversationId: "history",
    requiresPlanApproval: false,
  });
  const run = tasks.createRun({
    taskId: task.id,
    kind: "root",
    agent: "code",
    trigger: "create",
    input: { userMessage: task.goal },
  });
  const append = (event: TaskStreamEvent, runId = run.id) =>
    tasks.appendEvent({ taskId: task.id, runId, event });
  return { tasks, task, run, append, approvals: new ApprovalService(database.db, hub) };
}

it("跨页还原工具最终结果，按 Run 隔离且不把流式输出当作新操作", () => {
  const { tasks, task, run, append } = setup();
  const child = tasks.createRun({
    taskId: task.id,
    parentRunId: run.id,
    kind: "delegate",
    agent: "code",
    trigger: "delegate",
    input: { userMessage: "子操作" },
  });
  append({
    type: "tool_call",
    agent: "code",
    id: "write",
    name: "fs.write",
    args: { path: "one.txt" },
  });
  append(
    {
      type: "tool_call",
      agent: "code",
      id: "write",
      name: "fs.write",
      args: { path: "other.txt" },
    },
    child.id,
  );
  for (let index = 0; index < 505; index++)
    append({ type: "tool_output", agent: "code", toolCallId: "write", delta: "进度" });
  append({
    type: "tool_result",
    agent: "code",
    id: "write",
    result: { saved: true },
    isError: false,
  });
  append({
    type: "tool_call",
    agent: "code",
    id: "pending",
    name: "shell.run",
    args: { command: "publish" },
  });
  append({ type: "text_delta", agent: "code", delta: "即将结束" });
  const calls = readRunToolHistory(tasks, run.id);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    id: "write",
    args: { path: "one.txt" },
    result: { saved: true },
    isError: false,
  });
  expect(calls[1]).not.toHaveProperty("isError");
  expect(summarizeToolCalls([calls[1]!])).toContain("结果未确认");
  expect(summarizeToolCalls([calls[1]!])).not.toContain("完成");
  expect(readRunToolHistory(tasks, child.id)).toEqual([
    expect.objectContaining({ args: { path: "other.txt" } }),
  ]);
});

it("同一次 Run 内复用调用 ID 不覆盖旧操作，失败结果保留错误状态", () => {
  const { tasks, run, append } = setup();
  for (const path of ["first.txt", "second.txt"]) {
    append({ type: "tool_call", agent: "code", id: "same", name: "fs.write", args: { path } });
    append({
      type: "tool_result",
      agent: "code",
      id: "same",
      result: path === "first.txt" ? "saved" : "用户拒绝",
      isError: path !== "first.txt",
    });
  }
  const calls = readRunToolHistory(tasks, run.id);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ args: { path: "first.txt" }, result: "saved", isError: false });
  expect(calls[1]).toMatchObject({
    args: { path: "second.txt" },
    result: "用户拒绝",
    isError: true,
  });
});

it("委派中断把已落地的操作保存到子 Run，保留父子归属", () => {
  const { tasks, task, run, approvals } = setup();
  tasks.startRunDirect(run.id);
  const route = createDelegateHandler({
    tasks,
    approvals,
    taskId: task.id,
    parentRunId: run.id,
    signal: new AbortController().signal,
  })({ agent: "code", task: "创建报告" });
  route.emit({
    type: "tool_call",
    agent: "code",
    id: "write",
    name: "fs.write",
    args: { path: "report.md" },
  });
  route.emit({ type: "tool_result", agent: "code", id: "write", result: "saved", isError: false });
  route.done({ error: "上下文预算不足" });
  const child = tasks.listRuns(task.id).find((item) => item.parentRunId === run.id)!;
  expect(child.status).toBe("failed");
  expect(child.toolCalls).toEqual([
    expect.objectContaining({ name: "fs.write", result: "saved", isError: false }),
  ]);
  expect(readRunToolHistory(tasks, run.id)).toHaveLength(0);
});

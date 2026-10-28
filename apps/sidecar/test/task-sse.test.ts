import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let app: Hono;
const TOKEN = "test-token";

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-AgentDesk-Token": TOKEN,
      ...(init.headers ?? {}),
    },
  });

const json = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
  const res = await call(path, init);
  return (await res.json()) as T;
};

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-task-sse-test-"));
  const config = { ...loadConfig({ AGENTDESK_DATA_DIR: dataDir }), token: TOKEN };
  container = await createContainer(config, { inMemory: true });
  app = createApp(container);
});

afterAll(async () => {
  await container.dispose();
});

/** 把一个 SSE Response 包装成可持续读取、带内部缓冲的记录流，跳过 ping 心跳。 */
function createSseReader(res: Response) {
  if (!res.body) throw new Error("响应没有 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readUntil(count: number): Promise<Array<Record<string, unknown>>> {
    const records: Array<Record<string, unknown>> = [];
    while (records.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!dataLine) continue;
        const record = JSON.parse(dataLine) as Record<string, unknown>;
        if (record.type === "ping") continue;
        records.push(record);
        if (records.length >= count) break;
      }
    }
    return records;
  }

  return { reader, readUntil };
}

function createRootTask(goal: string) {
  const task = container.tasks.create({
    goal,
    conversationId: "conv-task-sse-test",
    requiresPlanApproval: false,
  });
  const run = container.tasks.createRun({
    taskId: task.id,
    kind: "root",
    agent: "orchestrator",
    trigger: "create",
    input: { userMessage: goal },
  });
  return { task, run };
}

describe("task events 快照 API", () => {
  it("手工写入事件后能按顺序、递增 seq 拿到全部事件", async () => {
    const { task, run } = createRootTask("快照 API 测试");
    const e1 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: run.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      },
    });
    const e2 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "tool_call",
        agent: "orchestrator",
        id: "t1",
        name: "projects.list",
        args: {},
      },
    });
    const e3 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "tool_result", agent: "orchestrator", id: "t1", result: [], isError: false },
    });
    const e4 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "run_ended", runId: run.id, status: "succeeded" },
    });

    const events = await json<Array<{ seq: number; event: { type: string } }>>(
      `/tasks/${task.id}/events?after=0`,
    );
    expect(events.map((e) => e.seq)).toEqual([e1.seq, e2.seq, e3.seq, e4.seq]);
    expect(events.map((e) => e.event.type)).toEqual([
      "run_started",
      "tool_call",
      "tool_result",
      "run_ended",
    ]);
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);
  });
});

describe("task SSE 断线重连", () => {
  it("断线期间追加的事件在重连后一条不多一条不少地按 seq 补齐", async () => {
    const { task, run } = createRootTask("断线重连测试");

    const res1 = await call(`/tasks/${task.id}/stream?after=0`);
    expect(res1.headers.get("content-type")).toContain("text/event-stream");
    const conn1 = createSseReader(res1);

    const e1 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: run.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      },
    });
    const e2 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "tool_call",
        agent: "orchestrator",
        id: "t1",
        name: "projects.list",
        args: {},
      },
    });

    const firstBatch = await conn1.readUntil(2);
    expect(firstBatch.map((r) => r.seq)).toEqual([e1.seq, e2.seq]);
    const lastSeq = (firstBatch.at(-1) as { seq: number }).seq;

    // 手动断开：不等待 run_ended
    await conn1.reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 断连期间没有任何客户端监听，这两条事件只落库
    const e3 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "tool_result", agent: "orchestrator", id: "t1", result: [], isError: false },
    });
    const e4 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "text_delta", agent: "orchestrator", delta: "处理中" },
    });

    const res2 = await call(`/tasks/${task.id}/stream?after=${lastSeq}`);
    const conn2 = createSseReader(res2);
    const secondBatch = await conn2.readUntil(2);
    expect(secondBatch.map((r) => r.seq)).toEqual([e3.seq, e4.seq]);

    // 重连之后继续追加的新事件应当实时推送，而不会重复补齐前面已经发过的事件
    const e5 = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "run_ended", runId: run.id, status: "succeeded" },
    });
    const thirdBatch = await conn2.readUntil(1);
    expect(thirdBatch.map((r) => r.seq)).toEqual([e5.seq]);

    await conn2.reader.cancel();
  });

  it("连接建立前 Run 已经跑完：历史补齐里直接命中终止事件，流立即结束而不是挂到下一次心跳", async () => {
    const { task, run } = createRootTask("连接前已结束测试");
    // 先把 run_started/run_ended 都写进库（模拟 resume 场景：POST 创建 Run 时 Run 已经同步执行完
    // 毕），再打开流——这些事件全部落在"历史补齐"阶段，而不是"订阅后的实时推送"阶段。
    const started = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: run.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      },
    });
    const ended = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "run_ended", runId: run.id, status: "succeeded" },
    });

    const res = await call(`/tasks/${task.id}/stream?after=0`);
    const conn = createSseReader(res);
    const batch = await conn.readUntil(2);
    expect(batch.map((r) => r.seq)).toEqual([started.seq, ended.seq]);

    const { done } = await conn.reader.read();
    expect(done).toBe(true);
  });

  it("历史里混有更早已结束的根 Run：只能用补齐后最新一条判定收尾，不能一遇到终止事件就提前收尾", async () => {
    const { task, run: firstRun } = createRootTask("历史多轮测试");
    const started1 = container.tasks.appendEvent({
      taskId: task.id,
      runId: firstRun.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: firstRun.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      },
    });
    const ended1 = container.tasks.appendEvent({
      taskId: task.id,
      runId: firstRun.id,
      parentRunId: null,
      event: { type: "run_ended", runId: firstRun.id, status: "succeeded" },
    });
    // 第二条根 Run（例如 resume）在连接建立前也已经跑完：历史里会先经过第一条 Run 的 run_ended，
    // 如果一遇到任意终止事件就提前收尾（而不是等整段历史补齐完再看最新一条），就会漏掉这一轮。
    const secondRun = container.tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "resume",
      input: { userMessage: "继续执行" },
    });
    const started2 = container.tasks.appendEvent({
      taskId: task.id,
      runId: secondRun.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: secondRun.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "resume",
      },
    });
    const ended2 = container.tasks.appendEvent({
      taskId: task.id,
      runId: secondRun.id,
      parentRunId: null,
      event: { type: "run_ended", runId: secondRun.id, status: "succeeded" },
    });

    const res = await call(`/tasks/${task.id}/stream?after=0`);
    const conn = createSseReader(res);
    const batch = await conn.readUntil(4);
    expect(batch.map((r) => r.seq)).toEqual([started1.seq, ended1.seq, started2.seq, ended2.seq]);

    const { done } = await conn.reader.read();
    expect(done).toBe(true);
  });

  it("单 Run 频道的 run_ended 会让 SSE 流自然结束", async () => {
    const { task, run } = createRootTask("run 频道终止测试");
    const res = await call(`/runs/${run.id}/stream?after=0`);
    const conn = createSseReader(res);

    const started = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: {
        type: "run_started",
        runId: run.id,
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      },
    });
    const ended = container.tasks.appendEvent({
      taskId: task.id,
      runId: run.id,
      parentRunId: null,
      event: { type: "run_ended", runId: run.id, status: "succeeded" },
    });

    const batch = await conn.readUntil(2);
    expect(batch.map((r) => r.seq)).toEqual([started.seq, ended.seq]);

    const { done } = await conn.reader.read();
    expect(done).toBe(true);
  });
});

describe("运行取消幂等", () => {
  it("连续两次取消同一个 run 都成功，cancel_requested 保持 true", async () => {
    const { run } = createRootTask("幂等取消测试");

    const first = await json<{ cancelRequested: boolean }>(`/runs/${run.id}/cancel`, {
      method: "POST",
    });
    expect(first.cancelRequested).toBe(true);

    const second = await call(`/runs/${run.id}/cancel`, { method: "POST" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { cancelRequested: boolean };
    expect(secondBody.cancelRequested).toBe(true);
  });
});

describe("POST /tasks 自动创建会话", () => {
  it("不传 conversationId 时自动新建会话并关联", async () => {
    const res = await call("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "自动建会话的任务" }),
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as { conversationId: string; status: string };
    expect(task.status).toBe("queued");
    expect(task.conversationId).toBeTruthy();

    const conversations = await json<Array<{ id: string }>>("/conversations");
    expect(conversations.some((c) => c.id === task.conversationId)).toBe(true);
  });
});

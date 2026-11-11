import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialSession, sessionReducer, type RunEventRecord } from "@agentdesk/shared";
import { createActivityProjector, projectActivity } from "../src/features/code/activity";
import {
  createTaskEventBuffer,
  type TaskEventSnapshot,
} from "../src/features/code/task-event-buffer";

function record(
  seq: number,
  event: RunEventRecord["event"],
  runId = "root",
  parentRunId: string | null = null,
): RunEventRecord {
  return { seq, taskId: "task", runId, parentRunId, event, createdAt: "2026-11-11T00:00:00Z" };
}

const started = record(1, {
  type: "run_started",
  runId: "root",
  parentRunId: null,
  agent: "code",
  trigger: "create",
});
const called = record(2, {
  type: "tool_call",
  agent: "code",
  id: "tool",
  name: "shell.run",
  args: { command: "test" },
});
const output = record(3, {
  type: "tool_output",
  agent: "code",
  toolCallId: "tool",
  delta: "output",
});

function scheduledBuffer() {
  const snapshots: TaskEventSnapshot[] = [];
  const callbacks = new Set<() => void>();
  const buffer = createTaskEventBuffer({
    taskId: "task",
    onPublish: (snapshot) => snapshots.push(snapshot),
    schedule: (flush) => {
      callbacks.add(flush);
      return () => {
        callbacks.delete(flush);
      };
    },
  });
  return {
    buffer,
    snapshots,
    callbacks,
    tick: () => {
      for (const flush of [...callbacks]) flush();
    },
  };
}

test("activity 增量投影保留工具、文件、文本、审批语义和旧快照", () => {
  const projector = createActivityProjector();
  const before = projector.append([started, called, output]);
  const preserved = structuredClone(before);
  const changes: RunEventRecord[] = [
    record(4, { type: "text_delta", agent: "code", delta: "正文" }),
    record(5, {
      type: "tool_result",
      agent: "code",
      id: "tool",
      result: { exitCode: 1 },
      isError: false,
    }),
    record(6, {
      type: "file_change",
      agent: "code",
      toolCallId: "tool",
      change: {
        path: "file.ts",
        operation: "edit",
        additions: 1,
        deletions: 0,
        diff: "+a",
        truncated: false,
        beforeHash: "before",
        afterHash: "after",
      },
    }),
    record(7, {
      type: "approval_required",
      approvalId: "approval",
      title: "命令审批",
      detail: "test",
    }),
    record(8, { type: "tool_call", agent: "code", id: "tool", name: "duplicate", args: {} }),
    record(9, { type: "run_ended", runId: "root", status: "succeeded" }),
  ];
  const after = projector.append(changes);
  assert.deepEqual(before, preserved);
  assert.equal(after.steps.length, 1);
  assert.equal(after.steps[0]?.name, "shell.run");
  assert.equal(after.steps[0]?.status, "error");
  assert.equal(after.steps[0]?.output, "output");
  assert.equal(after.textByRun.get("root"), "正文");
  assert.deepEqual([...after.approvalIds], ["approval"]);
  assert.deepEqual(after.changes, [
    {
      key: "root:6",
      runId: "root",
      change: changes[2]!.event.type === "file_change" ? changes[2]!.event.change : undefined,
      createdAt: started.createdAt,
    },
  ]);
  assert.deepEqual(after, projectActivity([started, called, output, ...changes]));
});

test("不同 Run 的同名工具相互隔离，结束状态与现有展示一致", () => {
  const records = [
    called,
    { ...called, seq: 3, runId: "child", parentRunId: "root" },
    record(4, { type: "run_ended", runId: "child", status: "cancelled" }, "child", "root"),
    record(5, { type: "run_ended", runId: "root", status: "succeeded" }),
  ];
  const activity = projectActivity(records);
  assert.deepEqual(
    activity.steps.map((step) => [step.key, step.status]),
    [
      ["root:tool", "error"],
      ["child:tool", "cancelled"],
    ],
  );
});

test("事件突发只调度一次，重复和过期 seq 不重复投影或存储", () => {
  const { buffer, snapshots, callbacks, tick } = scheduledBuffer();
  [started, called, output, called, output].forEach(buffer.append);
  assert.equal(callbacks.size, 1);
  assert.equal(snapshots.length, 0);
  tick();
  assert.equal(callbacks.size, 0);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.recordCount, 3);
  assert.equal(snapshots[0]?.lastSeq, 3);
  assert.deepEqual(snapshots[0]?.records, [started, called, output]);
  assert.deepEqual(buffer.getRecords(), [started, called, output]);
  assert.deepEqual(
    snapshots[0]?.runTree,
    [started, called, output].reduce(sessionReducer, createInitialSession()),
  );
  const history = buffer.getRecords();
  buffer.append(record(4, { type: "text_delta", agent: "code", delta: "next" }));
  tick();
  assert.equal(history.length, 3);
  assert.equal(snapshots[0]?.records.length, 3);
  assert.equal(snapshots[0]?.activity.textByRun.size, 0);
  assert.equal(snapshots[1]?.activity.textByRun.get("root"), "next");
});

test("委派、审批、错误与根终态完整回放，并立即发布关键状态", () => {
  const { buffer, snapshots, callbacks } = scheduledBuffer();
  const records = [
    started,
    record(
      2,
      {
        type: "run_started",
        runId: "child",
        parentRunId: "root",
        agent: "code",
        trigger: "delegate",
      },
      "child",
      "root",
    ),
    record(
      3,
      { type: "approval_required", approvalId: "approval", title: "审批", detail: "test" },
      "child",
      "root",
    ),
    record(4, { type: "error", message: "failed" }, "child", "root"),
    record(5, { type: "run_ended", runId: "child", status: "failed" }, "child", "root"),
    record(6, { type: "text_delta", agent: "code", delta: "final text" }),
    record(7, { type: "run_ended", runId: "root", status: "succeeded" }),
  ];
  records.forEach(buffer.append);
  assert.equal(snapshots.length, 4);
  assert.equal(callbacks.size, 0);
  assert.equal(buffer.getSnapshot().recordCount, records.length);
  assert.deepEqual(
    buffer.getSnapshot().runTree,
    records.reduce(sessionReducer, createInitialSession()),
  );
  assert.deepEqual(buffer.getSnapshot().activity, projectActivity(records));
  assert.equal(buffer.getSnapshot().runTree.runsById.root?.done, true);
  assert.equal(buffer.getSnapshot().runTree.runsById.child?.error, "failed");
});

test("任务切换丢弃旧 UI 发布，隔离异任务事件并允许新订阅从头回放", () => {
  const old = scheduledBuffer();
  old.buffer.append(started);
  const staleFlush = [...old.callbacks][0]!;
  old.buffer.dispose();
  old.buffer.append(called);
  staleFlush();
  assert.equal(old.snapshots.length, 0);
  assert.equal(old.callbacks.size, 0);
  const next = scheduledBuffer();
  next.buffer.append({ ...started, taskId: "other", seq: 999 });
  next.buffer.append(started);
  next.buffer.append(called);
  next.tick();
  assert.deepEqual(next.buffer.getRecords(), [started, called]);
  assert.equal(next.buffer.getSnapshot().lastSeq, 2);
});

test("长事件流保留全部原始记录，输出仅遵循已有展示上限", () => {
  const { buffer, snapshots, tick } = scheduledBuffer();
  const records = [
    started,
    called,
    { ...output, event: { ...output.event, delta: "x".repeat(90_000) } } as RunEventRecord,
  ];
  for (let seq = 4; seq <= 2_003; seq++) {
    records.push(record(seq, { type: "text_delta", agent: "code", delta: String(seq) }));
  }
  for (let offset = 0; offset < records.length; offset += 71) {
    records.slice(offset, offset + 71).forEach(buffer.append);
    tick();
  }
  assert.deepEqual(buffer.getRecords(), records);
  assert.equal(buffer.getSnapshot().recordCount, records.length);
  assert.equal(buffer.getSnapshot().activity.steps[0]?.output.length, 80_000);
  assert.deepEqual(buffer.getSnapshot().activity, projectActivity(records));
  assert.deepEqual(
    buffer.getSnapshot().runTree,
    records.reduce(sessionReducer, createInitialSession()),
  );
  assert.ok(snapshots.length < records.length / 50);
});

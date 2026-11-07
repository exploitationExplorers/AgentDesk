import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialSession,
  sessionReducer,
  type Artifact,
  type Run,
  type RunEventRecord,
  type Task,
  type TaskStreamEvent,
} from "@agentdesk/shared";
import {
  buildCollaborationModel,
  formatRunDuration,
} from "../src/features/code/collaboration-model";

const date = (second: number) => new Date(Date.UTC(2026, 10, 7, 8, 0, second)).toISOString();
const task: Task = {
  id: "task",
  title: "协作开发",
  goal: "实现协作视图",
  agent: "orchestrator",
  conversationId: "conversation",
  requiresPlanApproval: false,
  status: "running",
  currentRunId: "root",
  pendingApprovalId: null,
  createdAt: date(0),
  updatedAt: date(40),
  closedAt: null,
};
const run = (id: string, parentRunId: string | null = null, patch: Partial<Run> = {}): Run => ({
  id,
  taskId: task.id,
  parentRunId,
  kind: parentRunId ? "delegate" : "root",
  agent: parentRunId ? "code" : "orchestrator",
  status: "running",
  trigger: parentRunId ? "delegate" : "create",
  idempotencyKey: null,
  input: { userMessage: `任务 ${id}` },
  resultText: null,
  resultError: null,
  toolCalls: null,
  cancelRequested: false,
  cancelRequestedAt: null,
  startedAt: date(0),
  endedAt: null,
  createdAt: date(0),
  ...patch,
});
const record = (
  seq: number,
  runId: string,
  parentRunId: string | null,
  event: TaskStreamEvent,
): RunEventRecord => ({ seq, taskId: task.id, runId, parentRunId, createdAt: date(seq), event });
const started = (seq: number, id: string, parent: string | null) =>
  record(seq, id, parent, {
    type: "run_started",
    runId: id,
    parentRunId: parent,
    agent: parent ? "code" : "orchestrator",
    trigger: parent ? "delegate" : "create",
  });
const ended = (seq: number, id: string, parent: string | null, status: Run["status"]) =>
  record(seq, id, parent, { type: "run_ended", runId: id, status });
const build = (
  runs: Run[],
  records: RunEventRecord[] = [],
  overrides: Partial<Parameters<typeof buildCollaborationModel>[0]> = {},
) =>
  buildCollaborationModel({
    task,
    runs,
    records,
    session: records.reduce(sessionReducer, createInitialSession()),
    artifacts: [],
    pendingApprovalIds: new Set(),
    ...overrides,
  });

test("SSE 先于轮询到达时即可显示真实成员，结束事件覆盖旧快照", () => {
  const model = build(
    [run("root")],
    [started(1, "root", null), started(2, "child", "root"), ended(8, "child", "root", "succeeded")],
  );
  assert.equal(model.members.length, 1);
  assert.equal(model.members[0]?.id, "child");
  assert.equal(model.members[0]?.status, "succeeded");
  assert.equal(model.members[0]?.endedAt, Date.parse(date(8)));
  assert.equal(model.completed, 1);
});

test("已停止或失败的轮询快照不会被较早的运行中事件复活", () => {
  const model = build(
    [
      run("root", null, { status: "failed", endedAt: date(12) }),
      run("child", "root", { status: "cancelled", endedAt: date(11) }),
    ],
    [started(1, "root", null), started(2, "child", "root")],
  );
  assert.equal(model.root?.status, "failed");
  assert.equal(model.members[0]?.status, "cancelled");
  assert.equal(model.live, false);
  assert.equal(model.completed, 0);
  assert.equal(model.endedAt, Date.parse(date(12)));
});

test("已在另一端处理的审批不会因历史 approval_required 再次变成待确认", () => {
  const events = [
    started(1, "root", null),
    started(2, "child", "root"),
    record(3, "child", "root", {
      type: "approval_required",
      approvalId: "approval",
      title: "运行测试",
      detail: "pnpm test",
    }),
  ];
  assert.equal(
    build([run("root"), run("child", "root")], events, {
      pendingApprovalIds: new Set(["approval"]),
    }).members[0]?.status,
    "waiting",
  );
  assert.equal(build([run("root"), run("child", "root")], events).members[0]?.status, "running");
});

test("历史轮次隔离成员和成果，文件成果按最新版本去重", () => {
  const runs = [
    run("old", null, { status: "succeeded", endedAt: date(9) }),
    run("old-child", "old", { status: "succeeded", endedAt: date(8) }),
    run("root", null, { startedAt: date(10) }),
    run("child", "root", { startedAt: date(11) }),
  ];
  const artifact: Artifact = {
    id: "old-file",
    taskId: task.id,
    runId: "old-child",
    title: "旧结果",
    kind: "file",
    version: 1,
    content: null,
    filePath: "src/a.ts",
    mimeType: "text/plain",
    metadata: null,
    createdAt: date(8),
  };
  const artifacts = [
    artifact,
    { ...artifact, id: "new-file-v1", runId: "child", title: "新结果", createdAt: date(12) },
    {
      ...artifact,
      id: "new-file-v2",
      runId: "child",
      title: "修订结果",
      version: 2,
      createdAt: date(13),
    },
  ];
  const current = build(runs, [], { artifacts });
  assert.equal(current.root?.id, "root");
  assert.deepEqual(
    current.members.map((member) => member.id),
    ["child"],
  );
  assert.deepEqual(
    current.outputs.map((output) => output.id),
    ["new-file-v2"],
  );
  const historical = build(runs, [], { artifacts, rootId: "old" });
  assert.deepEqual(
    historical.members.map((member) => member.id),
    ["old-child"],
  );
  assert.deepEqual(
    historical.outputs.map((output) => output.id),
    ["old-file"],
  );
  assert.equal(historical.live, false);
});

test("保留嵌套委派的父子关系，根结束后收束缺少终态事件的子运行", () => {
  const model = build(
    [run("root"), run("child", "root"), run("nested", "child")],
    [started(1, "root", null), ended(10, "root", null, "cancelled")],
  );
  assert.equal(model.members.find((member) => member.id === "nested")?.parentId, "child");
  assert.ok(model.members.every((member) => member.status === "cancelled"));
  assert.ok(model.members.every((member) => member.endedAt === Date.parse(date(10))));
  assert.equal(model.live, false);
});

test("单 Agent 和空记录不生成虚构成员", () => {
  assert.equal(build([]).root, null);
  const model = build([run("root")]);
  assert.equal(model.members.length, 0);
  assert.equal(model.nodes.length, 1);
});

test("时间无效或倒序时不显示 NaN 或负耗时", () => {
  const model = build([
    run("root", null, {
      createdAt: "invalid",
      startedAt: null,
      status: "succeeded",
      endedAt: date(-1),
    }),
  ]);
  assert.equal(model.root?.startedAt, Date.parse(date(0)));
  assert.equal(model.root?.endedAt, Date.parse(date(0)));
  assert.equal(formatRunDuration(-9000), "00:00");
  assert.equal(formatRunDuration(90100), "01:30");
});

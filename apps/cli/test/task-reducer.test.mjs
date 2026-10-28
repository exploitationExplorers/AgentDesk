import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialSession,
  findPendingApproval,
  listRootRuns,
  sessionReducer,
} from "../src/interactive/task-reducer.mjs";

function reduceAll(session, actions) {
  return actions.reduce(sessionReducer, session);
}

function record(seq, runId, parentRunId, event) {
  return { seq, taskId: "task-1", runId, parentRunId, event, createdAt: `t${seq}` };
}

test("createInitialSession 返回空任务会话", () => {
  const session = createInitialSession();
  assert.equal(session.taskId, null);
  assert.equal(session.task, null);
  assert.deepEqual(session.runsById, {});
  assert.deepEqual(session.rootOrder, []);
});

test("run_started 建立根 Run，text_delta 只计入激活 agent 的输出", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
    record(2, "run-1", null, { type: "agent_start", agent: "orchestrator" }),
    record(3, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "你好" }),
    record(4, "run-1", null, { type: "text_delta", agent: "research", delta: "子 agent 不应出现" }),
    record(5, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "，已完成" }),
  ]);
  const [root] = listRootRuns(session);
  assert.equal(root.runId, "run-1");
  assert.equal(root.text, "你好，已完成");
  assert.equal(root.done, false);
});

test("tool_call 建行、tool_result 按 id 匹配补全", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "code",
      trigger: "create",
    }),
    record(2, "run-1", null, {
      type: "tool_call",
      agent: "code",
      id: "call-1",
      name: "fs.read",
      args: { path: "a.ts" },
    }),
    record(3, "run-1", null, {
      type: "tool_call",
      agent: "code",
      id: "call-2",
      name: "fs.read",
      args: { path: "b.ts" },
    }),
    record(4, "run-1", null, {
      type: "tool_result",
      agent: "code",
      id: "call-1",
      result: "ok",
      isError: false,
    }),
  ]);
  const [first, second] = session.runsById["run-1"].steps;
  assert.equal(first.done, true);
  assert.equal(first.result, "ok");
  assert.equal(second.done, false);
});

test("run_ended 标记根 Run 终态", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
    record(2, "run-1", null, { type: "run_ended", runId: "run-1", status: "succeeded" }),
  ]);
  const [root] = listRootRuns(session);
  assert.equal(root.done, true);
  assert.equal(root.runStatus, "succeeded");
});

test("task_status 与 plan_updated 更新任务级状态", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, { type: "task_status", status: "running" }),
    record(2, "run-1", null, { type: "plan_updated", artifactId: "artifact-1", version: 2 }),
  ]);
  assert.equal(session.task.status, "running");
  assert.deepEqual(session.plan, { artifactId: "artifact-1", version: 2 });
});

test("委派子 Run：run_started 挂一条 delegate 步骤到父 Run，子 Run 独立维护自己的步骤与文本", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
    record(2, "run-1", null, { type: "route", agent: "research", reason: "需要调研" }),
    record(3, "run-2", "run-1", {
      type: "run_started",
      runId: "run-2",
      parentRunId: "run-1",
      agent: "research",
      trigger: "delegate",
    }),
    record(4, "run-2", "run-1", { type: "agent_start", agent: "research" }),
    record(5, "run-2", "run-1", { type: "text_delta", agent: "research", delta: "调研结果" }),
    record(6, "run-2", "run-1", { type: "run_ended", runId: "run-2", status: "succeeded" }),
    record(7, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "总控总结" }),
  ]);
  // 根 Run 树里只有一个根（委派不产生新的根 Run），根 Run 自己的文本不包含子 Run 的输出。
  const roots = listRootRuns(session);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].text, "总控总结");
  const delegateStep = roots[0].steps.find((step) => step.kind === "delegate");
  assert.ok(delegateStep);
  assert.equal(delegateStep.runId, "run-2");
  const child = session.runsById["run-2"];
  assert.equal(child.text, "调研结果");
  assert.equal(child.done, true);
  assert.equal(child.runStatus, "succeeded");
  // 父 Run 的 steps 里既有独立的 route 步骤也有独立的 delegate 步骤，没有被拍平成一条。
  assert.equal(roots[0].steps.filter((step) => step.kind === "route").length, 1);
});

test("approval_required 阻塞并可通过 APPROVAL_ANSWERED 解决；findPendingApproval 跨整棵树定位", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "deploy",
      trigger: "create",
    }),
    record(2, "run-1", null, {
      type: "tool_call",
      agent: "deploy",
      id: "call-1",
      name: "deploy.run",
      args: {},
    }),
    record(3, "run-1", null, {
      type: "approval_required",
      approvalId: "appr-1",
      title: "确认部署",
      detail: "将执行部署脚本",
    }),
  ]);
  const pending = findPendingApproval(session);
  assert.equal(pending.runId, "run-1");
  assert.equal(pending.approvalId, "appr-1");
  session = sessionReducer(session, {
    type: "APPROVAL_ANSWERED",
    runId: "run-1",
    approvalId: "appr-1",
    approved: true,
  });
  assert.equal(findPendingApproval(session), null);
  const resolved = session.runsById["run-1"].steps.find((step) => step.kind === "approval");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.approved, true);
});

test("多条根 Run（followup/resume）依次出现在 rootOrder 中，各自独立维护步骤与状态", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
    record(2, "run-1", null, { type: "run_ended", runId: "run-1", status: "succeeded" }),
    record(3, "run-2", null, {
      type: "run_started",
      runId: "run-2",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "followup",
    }),
  ]);
  const roots = listRootRuns(session);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].done, true);
  assert.equal(roots[1].done, false);
  assert.equal(roots[1].trigger, "followup");
});

test("error 事件记录在对应 Run 上", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    record(1, "run-1", null, {
      type: "run_started",
      runId: "run-1",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
    record(2, "run-1", null, { type: "error", message: "模型请求失败" }),
  ]);
  assert.equal(session.runsById["run-1"].error, "模型请求失败");
});

test("ERROR 控制动作记录在会话级别", () => {
  let session = createInitialSession();
  session = sessionReducer(session, { type: "ERROR", message: "连接中断" });
  assert.equal(session.error, "连接中断");
});

test("SNAPSHOT 用快照 Task 与历史事件预填充初始状态，供 inspect --follow 续接", () => {
  const snapshot = {
    task: { id: "task-9", status: "running", title: "示例任务" },
    records: [
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      }),
      record(2, "run-1", null, {
        type: "text_delta",
        agent: "orchestrator",
        delta: "已完成一部分",
      }),
    ],
  };
  let session = createInitialSession();
  session = sessionReducer(session, { type: "SNAPSHOT", taskId: "task-9", snapshot });
  assert.equal(session.taskId, "task-9");
  assert.equal(session.task.status, "running");
  assert.equal(session.lastSeq, 2);
  const [root] = listRootRuns(session);
  assert.equal(root.text, "已完成一部分");
  // 续接：用快照最后一条 seq 之后的新事件继续 reduce，状态在快照基础上累加而不是从零开始。
  session = sessionReducer(
    session,
    record(3, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "，继续执行" }),
  );
  assert.equal(listRootRuns(session)[0].text, "已完成一部分，继续执行");
  assert.equal(session.lastSeq, 3);
});

test("INIT_TASK 只在没有任务快照时写入初始 Task", () => {
  let session = createInitialSession();
  session = sessionReducer(session, {
    type: "INIT_TASK",
    task: { id: "task-1", status: "pending" },
  });
  assert.equal(session.task.status, "pending");
  session = sessionReducer(
    session,
    record(1, "run-1", null, { type: "task_status", status: "running" }),
  );
  assert.equal(session.task.status, "running");
  // 已经有 task_status 更新过的快照后，INIT_TASK 不应覆盖回旧状态。
  session = sessionReducer(session, {
    type: "INIT_TASK",
    task: { id: "task-1", status: "pending" },
  });
  assert.equal(session.task.status, "running");
});

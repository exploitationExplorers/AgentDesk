import { expect, it } from "vitest";
import type { RunEventRecord } from "../src/contracts/task";
import {
  createInitialSession,
  findPendingApproval,
  listRootRuns,
  sessionReducer,
} from "../src/task-session";

function record(
  seq: number,
  runId: string,
  parentRunId: string | null,
  event: RunEventRecord["event"],
): RunEventRecord {
  return { seq, taskId: "task-1", runId, parentRunId, event, createdAt: "2026-01-01T00:00:00Z" };
}

it("run_started 建立父子委派关系，并在父 Run 上挂一条 DelegateStep", () => {
  let session = createInitialSession();
  session = sessionReducer(
    session,
    record(1, "root", null, {
      type: "run_started",
      runId: "root",
      parentRunId: null,
      agent: "orchestrator",
      trigger: "create",
    }),
  );
  session = sessionReducer(
    session,
    record(2, "child", "root", {
      type: "run_started",
      runId: "child",
      parentRunId: "root",
      agent: "code",
      trigger: "delegate",
    }),
  );
  expect(listRootRuns(session).map((n) => n.runId)).toEqual(["root"]);
  const root = session.runsById.root!;
  expect(root.steps).toEqual([
    { kind: "delegate", runId: "child", agent: "code", trigger: "delegate" },
  ]);
  expect(session.runsById.child?.parentRunId).toBe("root");
});

it("工具调用三段事件（call/output/result）归约到同一个 ToolStep", () => {
  let session = createInitialSession();
  session = sessionReducer(
    session,
    record(1, "root", null, {
      type: "run_started",
      runId: "root",
      parentRunId: null,
      agent: "code",
      trigger: "create",
    }),
  );
  session = sessionReducer(
    session,
    record(2, "root", null, {
      type: "tool_call",
      agent: "code",
      id: "t1",
      name: "fs.read",
      args: { path: "a.ts" },
    }),
  );
  session = sessionReducer(
    session,
    record(3, "root", null, {
      type: "tool_output",
      agent: "code",
      toolCallId: "t1",
      delta: "hello",
    }),
  );
  session = sessionReducer(
    session,
    record(4, "root", null, {
      type: "tool_result",
      agent: "code",
      id: "t1",
      result: "ok",
      isError: false,
    }),
  );
  const step = session.runsById.root!.steps[0];
  expect(step).toMatchObject({ kind: "tool", id: "t1", output: "hello", result: "ok", done: true });
});

it("auto_approved 落成一条 NoteStep，approval_required/APPROVAL_ANSWERED 走完整审批生命周期", () => {
  let session = createInitialSession();
  session = sessionReducer(
    session,
    record(1, "root", null, {
      type: "run_started",
      runId: "root",
      parentRunId: null,
      agent: "code",
      trigger: "create",
    }),
  );
  session = sessionReducer(
    session,
    record(2, "root", null, {
      type: "auto_approved",
      agent: "code",
      id: "t1",
      name: "shell.run",
      reason: "命中规则",
      source: "rule",
    }),
  );
  expect(session.runsById.root!.steps[0]).toEqual({
    kind: "note",
    text: "shell.run：命中规则",
    source: "rule",
  });
  session = sessionReducer(
    session,
    record(3, "root", null, {
      type: "approval_required",
      approvalId: "appr-1",
      title: "执行命令",
      detail: "ls -la",
    }),
  );
  expect(findPendingApproval(session)?.approvalId).toBe("appr-1");
  session = sessionReducer(session, {
    type: "APPROVAL_ANSWERED",
    runId: "root",
    approvalId: "appr-1",
    approved: true,
  });
  expect(findPendingApproval(session)).toBeNull();
  const approval = session.runsById.root!.steps.find((s) => s.kind === "approval");
  expect(approval).toMatchObject({ resolved: true, approved: true });
});

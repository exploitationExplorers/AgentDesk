import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import TaskView from "../src/interactive/TaskView.js";
import { resolveAccessibility } from "../src/interactive/theme.js";
import type { RunEventRecord, TaskStreamEvent } from "@agentdesk/shared";
import type { TaskSnapshot } from "../src/interactive/task-reducer.js";
import {
  baseTask,
  jsonResponse,
  mockApi,
  readBody,
  required,
  testState,
  type TaskConsumer,
  type TestInstance,
} from "./interactive-helpers.js";

const theme = resolveAccessibility({ tty: true, env: {}, settings: {} });

function pendingSnapshot(): TaskSnapshot {
  return {
    task: { ...baseTask, status: "running", pendingApprovalId: "snapshot-approval" },
    records: [
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "code",
        trigger: "create",
      }),
      record(2, "run-1", null, {
        type: "approval_required",
        approvalId: "snapshot-approval",
        title: "恢复的审批",
        detail: "来自历史快照",
      }),
    ],
  };
}

for (const source of ["local", "remote"] as const) {
  test(`快照中的待审批通过${source === "local" ? "终端" : "工作台"}处理，无需 SSE 重放`, async () => {
    let posts = 0;
    let remoteApproved = false;
    let streamStarted = false;
    const base = makeApiRequest({
      onApprovalResolved: () => {
        posts += 1;
      },
    });
    const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
      streamStarted = true;
      await onEvent(
        record(3, "run-1", null, { type: "text_delta", agent: "code", delta: "续接执行成功" }),
      );
      // 即使重连端重复发同一审批，也不能再次等待或 POST。
      await onEvent(
        record(4, "run-1", null, {
          type: "approval_required",
          approvalId: "snapshot-approval",
          title: "恢复的审批",
          detail: "来自历史快照",
        }),
      );
      await onEvent(
        record(5, "run-1", null, { type: "text_delta", agent: "code", delta: "，重复事件已处理" }),
      );
    });
    const snapshot = pendingSnapshot();
    const instance = render(
      createElement(TaskView, {
        state: testState,
        task: required(snapshot.task),
        snapshot,
        afterSeq: 2,
        theme,
        consumeSse,
        apiRequest: mockApi(async (state, path, options) => {
          if (path === "/approvals?status=pending")
            return jsonResponse(remoteApproved ? [] : [{ id: "snapshot-approval" }]);
          if (path === "/approvals")
            return jsonResponse([
              { id: "snapshot-approval", status: remoteApproved ? "approved" : "pending" },
            ]);
          return base(state, path, options);
        }),
      }),
    );
    try {
      await waitFor(instance, (frame) => frame.includes("恢复的审批"));
      assert.equal(streamStarted, false);
      if (source === "local") instance.stdin.write("y");
      else remoteApproved = true;
      await waitFor(instance, (frame) => frame.includes("重复事件已处理"), { timeout: 4000 });
      assert.equal(posts, source === "local" ? 1 : 0);
      assert.ok(!required(instance.lastFrame()).includes("需要审批"));
    } finally {
      settle();
      instance.unmount();
    }
  });
}

test("快照待审批时 Ctrl+C 退出，不发送批准或取消", async () => {
  const calls: { path: string; method?: string }[] = [];
  const snapshot = pendingSnapshot();
  const base = makeApiRequest();
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: required(snapshot.task),
      snapshot,
      afterSeq: 2,
      theme,
      consumeSse: async () => {
        throw new Error("不应在审批解决前续流");
      },
      apiRequest: mockApi(async (state, path, options) => {
        calls.push({ path, method: options.method });
        return base(state, path, options);
      }),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("恢复的审批"));
  instance.stdin.write("\x03");
  await delay(50);
  assert.ok(
    !calls.some(
      ({ path, method }) =>
        path.includes("/stream") || path.includes("/cancel") || method === "POST",
    ),
  );
  instance.unmount();
});

test("历史审批不遮蔽当前审批，处理后 Ctrl+O 仍可展开工具", async () => {
  const approval = (approvalId: string): TaskStreamEvent => ({
    type: "approval_required",
    approvalId,
    title: approvalId,
    detail: "",
  });
  const snapshot: TaskSnapshot = {
    task: { ...baseTask, status: "running", pendingApprovalId: "current-approval" },
    records: [
      record(1, "old-run", null, {
        type: "run_started",
        runId: "old-run",
        parentRunId: null,
        agent: "code",
        trigger: "create",
      }),
      record(2, "old-run", null, approval("finished-approval")),
      record(3, "old-run", null, { type: "run_ended", runId: "old-run", status: "succeeded" }),
      record(4, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "code",
        trigger: "followup",
      }),
      record(5, "run-1", null, approval("earlier-approval")),
      record(6, "run-1", null, approval("current-approval")),
    ],
  };
  const posts: string[] = [];
  const base = makeApiRequest();
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(7, "run-1", null, {
        type: "tool_call",
        agent: "code",
        id: "new-tool",
        name: "fs.read",
        args: { path: "current.ts" },
      }),
    );
    await onEvent(
      record(8, "run-1", null, {
        type: "tool_result",
        agent: "code",
        id: "new-tool",
        result: "审批后工具输出",
        isError: false,
      }),
    );
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: required(snapshot.task),
      snapshot,
      afterSeq: 6,
      theme,
      consumeSse,
      apiRequest: mockApi(async (state, path, options) => {
        if (options.method === "POST") posts.push(path);
        return base(state, path, options);
      }),
    }),
  );
  try {
    await waitFor(instance, (frame) => frame.includes("需要审批"));
    const frame = required(instance.lastFrame());
    assert.equal(frame.match(/需要审批/g)?.length, 1);
    assert.match(frame, /已处理或已结束/);
    assert.doesNotMatch(frame, /已拒绝/);
    instance.stdin.write("y");
    await waitFor(instance, (current) => current.includes("fs.read"));
    assert.deepEqual(posts, ["/approvals/current-approval"]);
    assert.doesNotMatch(required(instance.lastFrame()), /需要审批/);
    instance.stdin.write("\x0f");
    await waitFor(instance, (current) => current.includes("审批后工具输出"));
  } finally {
    settle();
    instance.unmount();
  }
});

function record(
  seq: number,
  runId: string,
  parentRunId: string | null,
  event: TaskStreamEvent,
): RunEventRecord {
  return { seq, taskId: "task-1", runId, parentRunId, event, createdAt: `t${seq}` };
}

function makeApiRequest({
  onApprovalResolved,
}: { onApprovalResolved?: (approved: boolean) => void } = {}) {
  return mockApi(async (_state, path, options) => {
    if (path.startsWith("/tasks/") && path.includes("/stream")) return new Response("");
    if (path.startsWith("/approvals/") && options.method === "POST") {
      onApprovalResolved?.(readBody(options).approved === true);
      return jsonResponse({ ok: true });
    }
    if (path.startsWith("/approvals")) return jsonResponse([]);
    throw new Error(`未预期的请求：${path}`);
  });
}

/**
 * 不让 consumeSse 的 promise 真正 resolve（只在测试里手动 settle）：TaskView 在 SSE 流结束后
 * 会自动调用 Ink 的 exit()，一旦触发就会清空 ink-testing-library 的帧缓冲，之后 lastFrame()
 * 永远拿到空字符串，没办法再断言任何中间状态。保持 promise pending 可以在断言阶段让组件持续挂载。
 */
function deferredConsumeSse(dispatch: (onEvent: Parameters<TaskConsumer>[1]) => Promise<void>) {
  let settle: () => void = () => {
    throw new Error("Stream not initialized");
  };
  const consumeSse: TaskConsumer = (_body, onEvent) =>
    new Promise<void>((resolve) => {
      settle = resolve;
      void dispatch(onEvent);
    });
  return { consumeSse, settle: () => settle() };
}

async function waitFor(
  instance: TestInstance,
  predicate: (frame: string) => boolean,
  { timeout = 2000, interval = 10 } = {},
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate(instance.lastFrame() ?? "")) return;
    await delay(interval);
  }
  throw new Error(`等待超时，最后一帧：\n${instance.lastFrame() ?? ""}`);
}

test("根 Run 流式文本渲染，run_ended/task_status 更新运行状态与状态栏", async () => {
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      }),
    );
    await onEvent(record(2, "run-1", null, { type: "agent_start", agent: "orchestrator" }));
    await onEvent(
      record(3, "run-1", null, {
        type: "text_delta",
        agent: "orchestrator",
        delta: "你好，已完成",
      }),
    );
    await onEvent(
      record(4, "run-1", null, { type: "run_ended", runId: "run-1", status: "succeeded" }),
    );
    await onEvent(record(5, "run-1", null, { type: "task_status", status: "completed" }));
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await waitFor(instance, (frame) => frame.includes("你好，已完成"));
  await waitFor(instance, (frame) => frame.includes("completed"));
  assert.ok(required(instance.lastFrame()).includes("succeeded"));
  settle();
  instance.unmount();
});

for (const remoteStatus of ["approved", "rejected"]) {
  test(`任务在工作台${remoteStatus === "approved" ? "批准" : "拒绝"}后继续，且不重复提交`, async () => {
    let remoteDecision = "pending";
    let posts = 0;
    const base = makeApiRequest({
      onApprovalResolved: () => {
        posts += 1;
      },
    });
    const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
      await onEvent(
        record(1, "run-1", null, {
          type: "run_started",
          runId: "run-1",
          parentRunId: null,
          agent: "code",
          trigger: "create",
        }),
      );
      await onEvent(
        record(2, "run-1", null, {
          type: "approval_required",
          approvalId: "remote-task",
          title: "写入代码",
          detail: "确认",
        }),
      );
      await onEvent(
        record(3, "run-1", null, { type: "text_delta", agent: "code", delta: "审批结果已同步" }),
      );
    });
    const instance = render(
      createElement(TaskView, {
        state: testState,
        task: baseTask,
        theme,
        consumeSse,
        apiRequest: mockApi(async (state, path, options) => {
          if (path === "/approvals?status=pending")
            return jsonResponse(remoteDecision === "pending" ? [{ id: "remote-task" }] : []);
          if (path === "/approvals")
            return jsonResponse([{ id: "remote-task", status: remoteDecision }]);
          return base(state, path, options);
        }),
      }),
    );
    try {
      await waitFor(instance, (frame) => frame.includes("需要审批"));
      remoteDecision = remoteStatus;
      await waitFor(instance, (frame) => frame.includes("审批结果已同步"), { timeout: 4000 });
      assert.ok(
        required(instance.lastFrame()).includes(remoteStatus === "approved" ? "已批准" : "已拒绝"),
      );
      assert.equal(posts, 0);
    } finally {
      settle();
      instance.unmount();
    }
  });
}

test("待审批时 Ctrl+C 解除等待并断开，不批准或取消任务", async () => {
  const calls: { path: string; method?: string }[] = [];
  let streamSignal: AbortSignal | null | undefined;
  let waitReleased = false;
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "code",
        trigger: "create",
      }),
    );
    await onEvent(
      record(2, "run-1", null, {
        type: "approval_required",
        approvalId: "exit-pending",
        title: "等待确认",
        detail: "",
      }),
    );
    waitReleased = true;
  });
  const base = makeApiRequest();
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      theme,
      consumeSse,
      apiRequest: mockApi(async (state, path, options) => {
        calls.push({ path, method: options?.method });
        if (path.includes("/stream")) streamSignal = options.signal;
        return base(state, path, options);
      }),
    }),
  );
  try {
    await waitFor(instance, (frame) => frame.includes("需要审批"));
    instance.stdin.write("\x03");
    await waitFor(instance, () => waitReleased);
    assert.equal(required(streamSignal).aborted, true);
    assert.ok(!calls.some(({ path, method }) => path.includes("/cancel") || method === "POST"));
  } finally {
    settle();
    instance.unmount();
  }
});

test("任务使用 Ctrl+O 展开工具，普通 o 不触发", async () => {
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "code",
        trigger: "create",
      }),
    );
    await onEvent(
      record(2, "run-1", null, {
        type: "tool_call",
        agent: "code",
        id: "shell-1",
        name: "shell.run",
        args: { command: "unique-command-detail" },
      }),
    );
    await onEvent(
      record(3, "run-1", null, {
        type: "tool_output",
        agent: "code",
        toolCallId: "shell-1",
        delta: "编译进度已更新",
      }),
    );
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      theme,
      consumeSse,
      apiRequest: makeApiRequest(),
    }),
  );
  try {
    await waitFor(instance, (frame) => frame.includes("shell.run"));
    instance.stdin.write("o");
    await delay(30);
    assert.ok(!required(instance.lastFrame()).includes("unique-command-detail"));
    instance.stdin.write("\x0f");
    await waitFor(instance, (frame) => frame.includes("unique-command-detail"));
    assert.ok(required(instance.lastFrame()).includes("编译进度已更新"));
  } finally {
    settle();
    instance.unmount();
  }
});

test("委派子 Run 嵌套渲染在对应的 delegate 步骤下，不与根 Run 文本拼接", async () => {
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      }),
    );
    await onEvent(
      record(2, "run-1", null, { type: "route", agent: "research", reason: "需要调研" }),
    );
    await onEvent(
      record(3, "run-2", "run-1", {
        type: "run_started",
        runId: "run-2",
        parentRunId: "run-1",
        agent: "research",
        trigger: "delegate",
      }),
    );
    await onEvent(record(4, "run-2", "run-1", { type: "agent_start", agent: "research" }));
    await onEvent(
      record(5, "run-2", "run-1", {
        type: "text_delta",
        agent: "research",
        delta: "子任务调研结论",
      }),
    );
    await onEvent(
      record(6, "run-2", "run-1", { type: "run_ended", runId: "run-2", status: "succeeded" }),
    );
    await onEvent(
      record(7, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "总控总结" }),
    );
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await waitFor(instance, (frame) => frame.includes("子任务调研结论"));
  const frame = required(instance.lastFrame());
  assert.ok(frame.includes("总控总结"));
  assert.ok(frame.includes("research"));
  settle();
  instance.unmount();
});

test("审批卡片：按 y 批准后继续流式输出", async () => {
  let approved: boolean | undefined;
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "deploy",
        trigger: "create",
      }),
    );
    await onEvent(
      record(2, "run-1", null, {
        type: "tool_call",
        agent: "deploy",
        id: "call-1",
        name: "deploy.run",
        args: {},
      }),
    );
    await onEvent(
      record(3, "run-1", null, {
        type: "approval_required",
        approvalId: "appr-1",
        title: "确认部署",
        detail: "将执行部署脚本",
      }),
    );
    await onEvent(
      record(4, "run-1", null, {
        type: "tool_result",
        agent: "deploy",
        id: "call-1",
        result: "deployed",
        isError: false,
      }),
    );
    await onEvent(
      record(5, "run-1", null, { type: "text_delta", agent: "deploy", delta: "部署完成" }),
    );
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      theme,
      apiRequest: makeApiRequest({
        onApprovalResolved: (value) => {
          approved = value;
        },
      }),
      consumeSse,
    }),
  );
  await waitFor(instance, (frame) => frame.includes("需要审批"));
  instance.stdin.write("y");
  await waitFor(instance, (frame) => frame.includes("部署完成"));
  assert.equal(approved, true);
  assert.ok(required(instance.lastFrame()).includes("已批准"));
  settle();
  instance.unmount();
});

test("Ctrl+C 断开本地连接并退出，不调用取消接口", async () => {
  const calls: string[] = [];
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(1, "run-1", null, {
        type: "run_started",
        runId: "run-1",
        parentRunId: null,
        agent: "orchestrator",
        trigger: "create",
      }),
    );
    await onEvent(
      record(2, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "处理中" }),
    );
  });
  const apiRequest = mockApi(async (_state, path) => {
    calls.push(path);
    if (path.includes("/stream")) return new Response("");
    throw new Error(`未预期的请求：${path}`);
  });
  const instance = render(
    createElement(TaskView, { state: testState, task: baseTask, theme, apiRequest, consumeSse }),
  );
  await waitFor(instance, (frame) => frame.includes("处理中"));
  instance.stdin.write("\x03");
  await delay(30);
  assert.ok(!calls.some((path) => path.includes("cancel")));
  settle();
  instance.unmount();
});

test("snapshot 预填充历史事件后，续接的新事件在已有文本基础上累加", async () => {
  const snapshot: TaskSnapshot = {
    task: { ...baseTask, status: "running" },
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
  const { consumeSse, settle } = deferredConsumeSse(async (onEvent) => {
    await onEvent(
      record(3, "run-1", null, { type: "text_delta", agent: "orchestrator", delta: "，继续执行" }),
    );
    await onEvent(
      record(4, "run-1", null, { type: "run_ended", runId: "run-1", status: "succeeded" }),
    );
  });
  const instance = render(
    createElement(TaskView, {
      state: testState,
      task: baseTask,
      snapshot,
      afterSeq: 2,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  // 挂载瞬间就应该已经展示快照里的文本，不等任何新事件到达。
  await waitFor(instance, (frame) => frame.includes("已完成一部分"));
  await waitFor(instance, (frame) => frame.includes("已完成一部分，继续执行"));
  settle();
  instance.unmount();
});

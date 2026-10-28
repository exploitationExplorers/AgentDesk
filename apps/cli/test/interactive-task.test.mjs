import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import TaskView from "../src/interactive/TaskView.jsx";
import { resolveAccessibility } from "../src/interactive/theme.mjs";

const theme = resolveAccessibility({ tty: true, env: {}, settings: {} });

function record(seq, runId, parentRunId, event) {
  return { seq, taskId: "task-1", runId, parentRunId, event, createdAt: `t${seq}` };
}

function makeApiRequest({ onApprovalResolved } = {}) {
  return async (_state, path, options = {}) => {
    if (path.startsWith("/tasks/") && path.includes("/stream")) return { body: {} };
    if (path.startsWith("/approvals/") && options.method === "POST") {
      onApprovalResolved?.(JSON.parse(options.body).approved);
      return { json: async () => ({ ok: true }) };
    }
    throw new Error(`未预期的请求：${path}`);
  };
}

/**
 * 不让 consumeSse 的 promise 真正 resolve（只在测试里手动 settle）：TaskView 在 SSE 流结束后
 * 会自动调用 Ink 的 exit()，一旦触发就会清空 ink-testing-library 的帧缓冲，之后 lastFrame()
 * 永远拿到空字符串，没办法再断言任何中间状态。保持 promise pending 可以在断言阶段让组件持续挂载。
 */
function deferredConsumeSse(dispatch) {
  let settle;
  const consumeSse = (_body, onEvent) =>
    new Promise((resolve) => {
      settle = resolve;
      void dispatch(onEvent);
    });
  return { consumeSse, settle: () => settle() };
}

async function waitFor(instance, predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate(instance.lastFrame() ?? "")) return;
    await delay(interval);
  }
  throw new Error(`等待超时，最后一帧：\n${instance.lastFrame() ?? ""}`);
}

const baseTask = { id: "task-1", status: "queued", title: "示例任务" };

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
      state: { port: 1 },
      task: baseTask,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await waitFor(instance, (frame) => frame.includes("你好，已完成"));
  await waitFor(instance, (frame) => frame.includes("completed"));
  assert.ok(instance.lastFrame().includes("succeeded"));
  settle();
  instance.unmount();
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
      state: { port: 1 },
      task: baseTask,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await waitFor(instance, (frame) => frame.includes("子任务调研结论"));
  const frame = instance.lastFrame();
  assert.ok(frame.includes("总控总结"));
  assert.ok(frame.includes("research"));
  settle();
  instance.unmount();
});

test("审批卡片：按 y 批准后继续流式输出", async () => {
  let approved;
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
      state: { port: 1 },
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
  assert.ok(instance.lastFrame().includes("已批准"));
  settle();
  instance.unmount();
});

test("Ctrl+C 断开本地连接并退出，不调用取消接口", async () => {
  const calls = [];
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
  const apiRequest = async (_state, path) => {
    calls.push(path);
    if (path.includes("/stream")) return { body: {} };
    throw new Error(`未预期的请求：${path}`);
  };
  const instance = render(
    createElement(TaskView, { state: { port: 1 }, task: baseTask, theme, apiRequest, consumeSse }),
  );
  await waitFor(instance, (frame) => frame.includes("处理中"));
  instance.stdin.write("\x03");
  await delay(30);
  assert.ok(!calls.some((path) => path.includes("cancel")));
  settle();
  instance.unmount();
});

test("snapshot 预填充历史事件后，续接的新事件在已有文本基础上累加", async () => {
  const snapshot = {
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
      state: { port: 1 },
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

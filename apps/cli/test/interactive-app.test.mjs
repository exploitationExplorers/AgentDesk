import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import App from "../src/interactive/App.jsx";
import { resolveAccessibility } from "../src/interactive/theme.mjs";

const theme = resolveAccessibility({ tty: true, env: {}, settings: {} });

function makeConsumeSse(events) {
  return async (_body, onEvent) => {
    for (const event of events) await onEvent(event);
  };
}

function makeApiRequest({ onApprovalResolved } = {}) {
  return async (_state, path, options = {}) => {
    if (path === "/chat") return { body: {} };
    if (path.startsWith("/approvals/") && options.method === "POST") {
      onApprovalResolved?.(JSON.parse(options.body).approved);
      return { json: async () => ({ ok: true }) };
    }
    if (path.startsWith("/approvals")) return { json: async () => [] };
    throw new Error(`未预期的请求：${path}`);
  };
}

async function waitFor(instance, predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate(instance.lastFrame() ?? "")) return;
    await delay(interval);
  }
  throw new Error(`等待超时，最后一帧：\n${instance.lastFrame() ?? ""}`);
}

// stdin 的 data 事件同步派发；紧跟着写入 Enter 会在受控 TextInput 提交上一次 React 状态更新前
// 抢先触发 onSubmit，拿到还未刷新的旧值。留一个微小的间隔让 React 先把输入值刷新到位。
async function typeAndSubmit(instance, text) {
  instance.stdin.write(text);
  await delay(30);
  instance.stdin.write("\r");
}

test("输入→提交→流式文本→落入历史", async () => {
  const events = [
    { type: "conversation", conversationId: "conv-1" },
    { type: "agent_start", agent: "orchestrator" },
    { type: "text_delta", agent: "orchestrator", delta: "你好" },
    { type: "done", messageId: "m1" },
  ];
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest(),
      consumeSse: makeConsumeSse(events),
    }),
  );
  await typeAndSubmit(instance, "早上好");
  await waitFor(instance, (frame) => frame.includes("你好"));
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(instance.lastFrame().includes("早上好"));
  instance.unmount();
});

test("工具调用卡片与审批卡片：批准后继续流式输出并落入历史", async () => {
  let approved;
  const events = [
    {
      type: "tool_call",
      agent: "deploy",
      id: "call-1",
      name: "deploy.run",
      args: { env: "prod" },
    },
    {
      type: "approval_required",
      approvalId: "appr-1",
      title: "确认部署",
      detail: "将执行部署脚本",
    },
    { type: "tool_result", agent: "deploy", id: "call-1", result: "deployed", isError: false },
    { type: "text_delta", agent: null, delta: "部署完成" },
    { type: "done", messageId: "m2" },
  ];
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest({
        onApprovalResolved: (value) => {
          approved = value;
        },
      }),
      consumeSse: makeConsumeSse(events),
    }),
  );
  await typeAndSubmit(instance, "部署一下");
  await waitFor(instance, (frame) => frame.includes("deploy.run"));
  await waitFor(instance, (frame) => frame.includes("需要审批"));
  instance.stdin.write("y");
  await waitFor(instance, (frame) => frame.includes("部署完成"));
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.equal(approved, true);
  assert.ok(instance.lastFrame().includes("已批准"));
  instance.unmount();
});

test("拒绝审批记录为已拒绝", async () => {
  let approved;
  const events = [
    { type: "approval_required", approvalId: "appr-2", title: "确认操作", detail: "" },
    { type: "done", messageId: "m3" },
  ];
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest({
        onApprovalResolved: (value) => {
          approved = value;
        },
      }),
      consumeSse: makeConsumeSse(events),
    }),
  );
  await typeAndSubmit(instance, "试一下");
  await waitFor(instance, (frame) => frame.includes("需要审批"));
  instance.stdin.write("n");
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.equal(approved, false);
  assert.ok(instance.lastFrame().includes("已拒绝"));
  instance.unmount();
});

test("Ctrl+C 在流式阶段中断当前这一轮，不等待网络请求收尾", async () => {
  let settle;
  const consumeSse = (_body, onEvent) =>
    new Promise((resolve) => {
      settle = resolve;
      void onEvent({ type: "text_delta", agent: null, delta: "处理中" });
    });
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await typeAndSubmit(instance, "长任务");
  await waitFor(instance, (frame) => frame.includes("处理中"));
  instance.stdin.write("\x03");
  await waitFor(instance, (frame) => frame.includes("已中断"));
  await waitFor(instance, (frame) => frame.includes("空闲"));
  settle();
  instance.unmount();
});

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

function makeApiRequest({ onApprovalResolved, conversations, history } = {}) {
  return async (_state, path, options = {}) => {
    if (path === "/chat") return { body: {} };
    if (path === "/conversations") {
      if (conversations) return { json: async () => conversations };
      throw new Error("未预期的请求：/conversations");
    }
    if (path.startsWith("/conversations/") && path.endsWith("/messages")) {
      const id = path.split("/")[2];
      return { json: async () => history?.[id] ?? [] };
    }
    if (path.startsWith("/approvals/") && options.method === "POST") {
      onApprovalResolved?.(JSON.parse(options.body).approved);
      return { json: async () => ({ ok: true }) };
    }
    if (path.startsWith("/approvals")) return { json: async () => [] };
    throw new Error(`未预期的请求：${path}`);
  };
}

function lineWith(frame, needle) {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
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

test("有多个历史会话时启动显示选择器", async () => {
  const conversations = [
    {
      id: "conv-a",
      title: "第一个话题",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "conv-b",
      title: "第二个话题",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
  ];
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest({ conversations }),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("新建对话"));
  const frame = instance.lastFrame();
  assert.ok(frame.includes("第一个话题"));
  assert.ok(frame.includes("第二个话题"));
  instance.unmount();
});

test("选择已有会话后正确回放历史", async () => {
  const conversations = [
    {
      id: "conv-a",
      title: "旧话题",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  const history = {
    "conv-a": [
      { role: "user", content: "之前问过的问题", agent: null, toolCalls: [] },
      { role: "assistant", content: "之前的回答", agent: "orchestrator", toolCalls: [] },
    ],
  };
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest({ conversations, history }),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("新建对话"));
  instance.stdin.write("\x1B[B");
  await delay(30);
  instance.stdin.write("\r");
  await waitFor(instance, (frame) => frame.includes("之前的回答"));
  assert.ok(instance.lastFrame().includes("之前问过的问题"));
  instance.unmount();
});

test("选择新建对话后是空会话", async () => {
  const conversations = [
    {
      id: "conv-a",
      title: "旧话题",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest({ conversations }),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("新建对话"));
  instance.stdin.write("\r");
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(!instance.lastFrame().includes("旧话题"));
  instance.unmount();
});

test("显式传入 --conversation 时跳过选择器", async () => {
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      conversationId: "conv-z",
      apiRequest: makeApiRequest(),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(!instance.lastFrame().includes("选择会话"));
  instance.unmount();
});

test("Tab 切换到步骤焦点后上下移动高亮", async () => {
  let settle;
  const consumeSse = (_body, onEvent) =>
    new Promise((resolve) => {
      settle = resolve;
      void onEvent({
        type: "tool_call",
        agent: "code",
        id: "call-1",
        name: "fs.read",
        args: { path: "a.ts" },
      });
      void onEvent({
        type: "tool_call",
        agent: "code",
        id: "call-2",
        name: "fs.write",
        args: { path: "b.ts" },
      });
    });
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await typeAndSubmit(instance, "读取并写入文件");
  await waitFor(instance, (frame) => frame.includes("fs.write"));
  instance.stdin.write("\t");
  await delay(30);
  let frame = instance.lastFrame();
  assert.ok(lineWith(frame, "fs.read").includes("▌"));
  assert.ok(!lineWith(frame, "fs.write").includes("▌"));
  instance.stdin.write("\x1B[B");
  await delay(30);
  frame = instance.lastFrame();
  assert.ok(!lineWith(frame, "fs.read").includes("▌"));
  assert.ok(lineWith(frame, "fs.write").includes("▌"));
  settle();
  instance.unmount();
});

test("Enter 单独展开聚焦行而其他行保持折叠", async () => {
  let settle;
  const consumeSse = (_body, onEvent) =>
    new Promise((resolve) => {
      settle = resolve;
      void onEvent({
        type: "tool_call",
        agent: "code",
        id: "call-1",
        name: "fs.read",
        args: { path: "a.ts" },
      });
      void onEvent({
        type: "tool_call",
        agent: "code",
        id: "call-2",
        name: "fs.write",
        args: { path: "b.ts" },
      });
    });
  const instance = render(
    createElement(App, {
      state: { port: 1 },
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await typeAndSubmit(instance, "读取并写入文件");
  await waitFor(instance, (frame) => frame.includes("fs.write"));
  instance.stdin.write("\t");
  await delay(30);
  instance.stdin.write("\r");
  await delay(30);
  const frame = instance.lastFrame();
  assert.ok(frame.includes("a.ts"));
  assert.ok(!frame.includes("b.ts"));
  settle();
  instance.unmount();
});

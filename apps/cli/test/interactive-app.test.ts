import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import App from "../src/interactive/App.js";
import { resolveAccessibility } from "../src/interactive/theme.js";
import type { AgentStreamEvent, Conversation } from "@agentdesk/shared";
import type { HistoryMessage } from "../src/interactive/types.js";
import {
  jsonResponse,
  mockApi,
  readBody,
  required,
  testState,
  type EventConsumer,
  type TestInstance,
} from "./interactive-helpers.js";

const theme = resolveAccessibility({ tty: true, env: {}, settings: {} });
afterEach(cleanup);

for (const selection of ["new", "resume"] as const) {
  test(`历史列表延迟返回后${selection === "new" ? "新建" : "恢复"}会话，欢迎区仍只输出一次`, async () => {
    let release: (response: Response) => void = () => {
      throw new Error("History request not started");
    };
    const historyResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const base = makeApiRequest({
      history: {
        "delayed-conversation": [
          { role: "user", content: "历史问题" },
          { role: "assistant", content: "历史回答", agent: "code", toolCalls: [] },
        ],
      },
    });
    const instance = render(
      createElement(App, {
        state: testState,
        theme,
        version: "0.1.0",
        cwd: "D:/agent/AgentDesk",
        apiRequest: mockApi(async (state, path, options) =>
          path === "/conversations" ? historyResponse : base(state, path, options),
        ),
        consumeSse: makeConsumeSse([]),
      }),
    );
    await waitFor(instance, (frame) => frame.includes("AgentDesk"));
    assert.equal(required(instance.lastFrame()).match(/AgentDesk\s+v/g)?.length, 1);
    release(
      jsonResponse([
        {
          id: "delayed-conversation",
          title: "旧会话",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ]),
    );
    await waitFor(instance, (frame) => frame.includes("选择会话"));
    assert.equal(required(instance.lastFrame()).match(/AgentDesk\s+v/g)?.length, 1);
    if (selection === "resume") {
      instance.stdin.write("\x1B[B");
      await delay(30);
    }
    instance.stdin.write("\r");
    await waitFor(instance, (frame) =>
      frame.includes(selection === "resume" ? "历史回答" : "空闲"),
    );
    assert.equal(required(instance.lastFrame()).match(/AgentDesk\s+v/g)?.length, 1);
    instance.unmount();
  });
}

test("输入代码中的 o 不触发快捷键，显示新的 AgentDesk 启动区", async () => {
  let sent: unknown;
  const base = makeApiRequest({ conversations: [] });
  const instance = render(
    createElement(App, {
      state: testState,
      theme,
      apiRequest: mockApi(async (state, path, options) => {
        if (path === "/chat") sent = readBody(options).message;
        return base(state, path, options);
      }),
      consumeSse: makeConsumeSse([{ type: "done", messageId: "m-o" }]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("AgentDesk"));
  instance.stdin.write("o");
  await delay(30);
  instance.stdin.write("\r");
  await waitFor(instance, () => sent === "o");
  instance.unmount();
});

test("工作台处理审批后终端自动继续读取事件", async () => {
  let remotelyApproved = false;
  let approvalPosts = 0;
  const base = makeApiRequest({ conversations: [] });
  const instance = render(
    createElement(App, {
      state: testState,
      theme,
      apiRequest: mockApi(async (state, path, options) => {
        if (path.startsWith("/approvals/") && options?.method === "POST") approvalPosts += 1;
        if (path === "/approvals")
          return jsonResponse([
            { id: "remote-approval", status: remotelyApproved ? "approved" : "pending" },
          ]);
        if (path === "/approvals?status=pending")
          return jsonResponse(remotelyApproved ? [] : [{ id: "remote-approval" }]);
        return base(state, path, options);
      }),
      consumeSse: makeConsumeSse([
        {
          type: "approval_required",
          approvalId: "remote-approval",
          title: "写入文件",
          detail: "确认",
        },
        { type: "text_delta", agent: "code", delta: "跨端审批后完成" },
        { type: "done", messageId: "remote-done" },
      ]),
    }),
  );
  await typeAndSubmit(instance, "修改代码");
  await waitFor(instance, (frame) => frame.includes("需要审批"));
  remotelyApproved = true;
  await waitFor(instance, (frame) => frame.includes("跨端审批后完成"), { timeout: 4000 });
  assert.equal(approvalPosts, 0, "远端已处理的审批不应再次提交");
  instance.unmount();
});

function makeConsumeSse(events: AgentStreamEvent[]): EventConsumer {
  return async (_body, onEvent) => {
    for (const event of events) await onEvent(event);
  };
}

function makeApiRequest({
  onApprovalResolved,
  conversations,
  history,
}: {
  onApprovalResolved?: (approved: boolean) => void;
  conversations?: Conversation[];
  history?: Record<string, HistoryMessage[]>;
} = {}) {
  return mockApi(async (_state, path, options) => {
    if (path === "/chat") return new Response("");
    if (path === "/conversations") {
      if (conversations) return jsonResponse(conversations);
      throw new Error("未预期的请求：/conversations");
    }
    if (path.startsWith("/conversations/") && path.endsWith("/messages")) {
      const id = path.split("/")[2];
      return jsonResponse(id ? (history?.[id] ?? []) : []);
    }
    if (path.startsWith("/approvals/") && options.method === "POST") {
      onApprovalResolved?.(readBody(options).approved === true);
      return jsonResponse({ ok: true });
    }
    if (path.startsWith("/approvals")) return jsonResponse([]);
    throw new Error(`未预期的请求：${path}`);
  });
}

function lineWith(frame: string, needle: string) {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
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

// stdin 的 data 事件同步派发；紧跟着写入 Enter 会在受控 TextInput 提交上一次 React 状态更新前
// 抢先触发 onSubmit，拿到还未刷新的旧值。留一个微小的间隔让 React 先把输入值刷新到位。
async function typeAndSubmit(instance: TestInstance, text: string) {
  instance.stdin.write(text);
  await delay(30);
  instance.stdin.write("\r");
}

test("输入→提交→流式文本→落入历史", async () => {
  const events: AgentStreamEvent[] = [
    { type: "conversation", conversationId: "conv-1" },
    { type: "agent_start", agent: "orchestrator" },
    { type: "text_delta", agent: "orchestrator", delta: "你好" },
    { type: "done", messageId: "m1" },
  ];
  const instance = render(
    createElement(App, {
      state: testState,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse: makeConsumeSse(events),
    }),
  );
  await typeAndSubmit(instance, "早上好");
  await waitFor(instance, (frame) => frame.includes("你好"));
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(required(instance.lastFrame()).includes("早上好"));
  instance.unmount();
});

test("工具调用卡片与审批卡片：批准后继续流式输出并落入历史", async () => {
  let approved: boolean | undefined;
  const events: AgentStreamEvent[] = [
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
    { type: "text_delta", agent: "orchestrator", delta: "部署完成" },
    { type: "done", messageId: "m2" },
  ];
  const instance = render(
    createElement(App, {
      state: testState,
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
  assert.ok(required(instance.lastFrame()).includes("已批准"));
  instance.unmount();
});

test("拒绝审批记录为已拒绝", async () => {
  let approved: boolean | undefined;
  const events: AgentStreamEvent[] = [
    { type: "approval_required", approvalId: "appr-2", title: "确认操作", detail: "" },
    { type: "done", messageId: "m3" },
  ];
  const instance = render(
    createElement(App, {
      state: testState,
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
  assert.ok(required(instance.lastFrame()).includes("已拒绝"));
  instance.unmount();
});

test("Ctrl+C 在流式阶段中断当前这一轮，不等待网络请求收尾", async () => {
  let settle: () => void = () => {
    throw new Error("Stream not initialized");
  };
  const consumeSse: EventConsumer = (_body, onEvent) =>
    new Promise<void>((resolve) => {
      settle = resolve;
      void onEvent({ type: "text_delta", agent: "orchestrator", delta: "处理中" });
    });
  const instance = render(
    createElement(App, {
      state: testState,
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
      state: testState,
      theme,
      apiRequest: makeApiRequest({ conversations }),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("新建对话"));
  const frame = required(instance.lastFrame());
  assert.equal(
    (frame.match(/AgentDesk\s+v/g) ?? []).length,
    1,
    `历史选择器只显示一个欢迎区：\n${frame}`,
  );
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
  const history: Record<string, HistoryMessage[]> = {
    "conv-a": [
      { role: "user", content: "之前问过的问题", agent: null, toolCalls: [] },
      { role: "assistant", content: "之前的回答", agent: "orchestrator", toolCalls: [] },
    ],
  };
  const instance = render(
    createElement(App, {
      state: testState,
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
  assert.ok(required(instance.lastFrame()).includes("之前问过的问题"));
  assert.equal(
    (required(instance.lastFrame()).match(/AgentDesk\s+v/g) ?? []).length,
    1,
    "恢复会话不重复欢迎区",
  );
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
      state: testState,
      theme,
      apiRequest: makeApiRequest({ conversations }),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("新建对话"));
  instance.stdin.write("\r");
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(!required(instance.lastFrame()).includes("旧话题"));
  assert.equal(
    (required(instance.lastFrame()).match(/AgentDesk\s+v/g) ?? []).length,
    1,
    "新建会话不重复欢迎区",
  );
  instance.unmount();
});

test("显式传入 --conversation 时跳过选择器", async () => {
  const instance = render(
    createElement(App, {
      state: testState,
      theme,
      conversationId: "conv-z",
      apiRequest: makeApiRequest(),
      consumeSse: makeConsumeSse([]),
    }),
  );
  await waitFor(instance, (frame) => frame.includes("空闲"));
  assert.ok(!required(instance.lastFrame()).includes("选择会话"));
  instance.unmount();
});

test("Tab 切换到步骤焦点后上下移动高亮", async () => {
  let settle: () => void = () => {
    throw new Error("Stream not initialized");
  };
  const consumeSse: EventConsumer = (_body, onEvent) =>
    new Promise<void>((resolve) => {
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
      state: testState,
      theme,
      apiRequest: makeApiRequest(),
      consumeSse,
    }),
  );
  await typeAndSubmit(instance, "读取并写入文件");
  await waitFor(instance, (frame) => frame.includes("fs.write"));
  instance.stdin.write("\t");
  await delay(30);
  let frame = required(instance.lastFrame());
  assert.ok(lineWith(frame, "fs.read").includes("▌"));
  assert.ok(!lineWith(frame, "fs.write").includes("▌"));
  instance.stdin.write("\x1B[B");
  await delay(30);
  frame = required(instance.lastFrame());
  assert.ok(!lineWith(frame, "fs.read").includes("▌"));
  assert.ok(lineWith(frame, "fs.write").includes("▌"));
  settle();
  instance.unmount();
});

test("Enter 单独展开聚焦行而其他行保持折叠", async () => {
  let settle: () => void = () => {
    throw new Error("Stream not initialized");
  };
  const consumeSse: EventConsumer = (_body, onEvent) =>
    new Promise<void>((resolve) => {
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
      state: testState,
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
  const frame = required(instance.lastFrame());
  assert.ok(frame.includes("a.ts"));
  assert.ok(!frame.includes("b.ts"));
  settle();
  instance.unmount();
});

import type { HistoryMessage } from "../src/interactive/types.js";
import type { ChatAction, ChatSession } from "../src/interactive/chat-reducer.js";
import { makeApproval, required, toolStep } from "./interactive-helpers.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialSession,
  sessionReducer,
  turnsFromMessages,
} from "../src/interactive/chat-reducer.js";

function reduceAll(session: ChatSession, actions: ChatAction[]) {
  return actions.reduce(sessionReducer, session);
}

test("createInitialSession 返回空闲会话", () => {
  const session = createInitialSession();
  assert.equal(session.status, "idle");
  assert.equal(session.conversationId, null);
  assert.equal(session.live, null);
  assert.deepEqual(session.turns, []);
});

test("SUBMIT 开启一轮新对话，TURN_SETTLED 落入历史", () => {
  let session = createInitialSession();
  session = sessionReducer(session, { type: "SUBMIT", message: "你好" });
  assert.equal(session.status, "streaming");
  assert.equal(required(session.live).userMessage, "你好");
  session = sessionReducer(session, { type: "text_delta", agent: "orchestrator", delta: "世界" });
  assert.equal(required(session.live).text, "世界");
  session = sessionReducer(session, { type: "done", messageId: "m1" });
  session = sessionReducer(session, { type: "TURN_SETTLED" });
  assert.equal(session.status, "idle");
  assert.equal(session.live, null);
  assert.equal(session.turns.length, 1);
  assert.equal(required(session.turns[0]).text, "世界");
});

test("只有当前活跃 agent 的 text_delta 计入可见回答，子 agent 输出不计入", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    { type: "SUBMIT", message: "调研一下" },
    { type: "route", agent: "research", reason: "需要调研" },
    { type: "agent_start", agent: "orchestrator" },
    { type: "text_delta", agent: "orchestrator", delta: "总控说：" },
    { type: "text_delta", agent: "research", delta: "子 agent 的输出不应出现" },
    { type: "text_delta", agent: "orchestrator", delta: "已完成" },
  ]);
  assert.equal(required(session.live).text, "总控说：已完成");
  assert.equal(required(required(session.live).steps[0]).kind, "route");
});

test("tool_call 建行、tool_result 按 id 匹配补全", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    { type: "SUBMIT", message: "读取文件" },
    { type: "tool_call", agent: "code", id: "call-1", name: "fs.read", args: { path: "a.ts" } },
    { type: "tool_call", agent: "code", id: "call-2", name: "fs.read", args: { path: "b.ts" } },
    { type: "tool_result", agent: "code", id: "call-1", result: "ok", isError: false },
  ]);
  const [first, second] = required(session.live).steps;
  assert.equal(toolStep(first).done, true);
  assert.equal(toolStep(first).result, "ok");
  assert.equal(toolStep(second).done, false);
  assert.equal(toolStep(second).result, undefined);
});

test("审批往返：approval_required 阻塞状态，APPROVAL_ANSWERED 恢复并记录结果", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    { type: "SUBMIT", message: "部署一下" },
    { type: "tool_call", agent: "deploy", id: "call-1", name: "deploy.run", args: {} },
    {
      type: "approval_required",
      approvalId: "appr-1",
      title: "确认部署",
      detail: "将执行部署脚本",
    },
  ]);
  assert.equal(session.status, "awaiting-approval");
  const approvalStep = required(session.live).steps.find((step) => step.kind === "approval");
  assert.equal(required(approvalStep).resolved, false);

  session = sessionReducer(session, {
    type: "APPROVAL_ANSWERED",
    approvalId: "appr-1",
    approved: true,
  });
  assert.equal(session.status, "streaming");
  const resolved = required(session.live).steps.find((step) => step.kind === "approval");
  assert.equal(required(resolved).resolved, true);
  assert.equal(required(resolved).approved, true);

  session = reduceAll(session, [
    { type: "tool_result", agent: "deploy", id: "call-1", result: "deployed", isError: false },
    { type: "done", messageId: "m1" },
    { type: "TURN_SETTLED" },
  ]);
  assert.equal(session.status, "idle");
  assert.equal(
    required(required(session.turns[0]).steps.find((s) => s.kind === "approval")).approved,
    true,
  );
});

test("error 事件记录在当前轮次，结束后仍会落入历史", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    { type: "SUBMIT", message: "触发错误" },
    { type: "error", message: "模型请求失败" },
    { type: "TURN_SETTLED" },
  ]);
  assert.equal(required(session.turns[0]).error, "模型请求失败");
  assert.equal(session.status, "idle");
});

test("ABORT_TURN 中断当前这一轮并标记为已中断，不影响空闲状态", () => {
  let session = createInitialSession();
  session = reduceAll(session, [
    { type: "SUBMIT", message: "慢任务" },
    { type: "text_delta", agent: "orchestrator", delta: "进行中" },
    { type: "ABORT_TURN" },
  ]);
  assert.equal(session.status, "idle");
  assert.equal(session.live, null);
  assert.equal(required(session.turns[0]).text, "进行中");
  assert.equal(required(session.turns[0]).error, "已中断");

  const idle = sessionReducer(session, { type: "ABORT_TURN" });
  assert.equal(idle.status, "idle");
  assert.equal(idle.turns.length, 1);
});

test("conversation 事件记录会话 id；APPROVALS_POLLED 更新跨会话待处理角标", () => {
  let session = createInitialSession();
  session = sessionReducer(session, { type: "conversation", conversationId: "conv-1" });
  assert.equal(session.conversationId, "conv-1");
  session = sessionReducer(session, {
    type: "APPROVALS_POLLED",
    approvals: [makeApproval("a1"), makeApproval("a2")],
  });
  assert.equal(session.pendingApprovals.length, 2);
});

test("turnsFromMessages 把历史消息还原成已完成轮次，工具调用记为已完成", () => {
  const messages: HistoryMessage[] = [
    { role: "user", content: "你好", agent: null, toolCalls: [] },
    {
      role: "assistant",
      content: "你好！",
      agent: "orchestrator",
      toolCalls: [{ id: "t1", name: "fs.read", args: { path: "a.ts" }, result: "ok" }],
    },
    { role: "user", content: "还在吗", agent: null, toolCalls: [] },
  ];
  const turns = turnsFromMessages(messages);
  assert.equal(turns.length, 2);
  assert.equal(required(turns[0]).userMessage, "你好");
  assert.equal(required(turns[0]).text, "你好！");
  assert.equal(toolStep(required(turns[0]).steps[0]).done, true);
  assert.equal(required(turns[1]).userMessage, "还在吗");
  assert.equal(required(turns[1]).text, "");
});

test("RESUME 把历史回放追加到现有 turns 之后并设置会话 id", () => {
  let session = createInitialSession();
  session = sessionReducer(session, {
    type: "RESUME",
    conversationId: "conv-9",
    messages: [{ role: "user", content: "继续", agent: null, toolCalls: [] }],
  });
  assert.equal(session.conversationId, "conv-9");
  assert.equal(session.turns.length, 1);
  assert.equal(required(session.turns[0]).userMessage, "继续");
});

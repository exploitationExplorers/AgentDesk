import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChatProgress, reduceChatProgress, type AgentStreamEvent } from "@agentdesk/shared";
import { createChatEventBuffer } from "../src/features/chat/chat-event-buffer";

test("150 text deltas retain Markdown and Unicode while sharing a 40 ms update", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: AgentStreamEvent[][] = [];
  const buffer = createChatEventBuffer((events) => batches.push(events), {
    signal: new AbortController().signal,
  });
  const chunks = Array.from({ length: 150 }, (_, index) => `\n- 第 ${index} 项：**保留** 🧑‍💻`);
  for (const delta of chunks) buffer.push({ type: "text_delta", agent: "code", delta });
  t.mock.timers.tick(39);
  assert.equal(batches.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(batches, [[{ type: "text_delta", agent: "code", delta: chunks.join("") }]]);
  buffer.flush();
  assert.equal(batches.length, 1);
  buffer.dispose();
});

test("buffered multi-agent text and tool boundaries match the unbuffered timeline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original: AgentStreamEvent[] = [
    { type: "agent_start", agent: "code" },
    { type: "text_delta", agent: "code", delta: "检查" },
    { type: "text_delta", agent: "code", delta: "项目。" },
    { type: "text_delta", agent: "research", delta: "子 Agent 输出" },
    { type: "text_delta", agent: "code", delta: "继续。" },
    { type: "tool_call", agent: "code", id: "read", name: "fs.read", args: {} },
    { type: "tool_result", agent: "code", id: "read", result: "ok", isError: false },
    { type: "response_start", agent: "code" },
    { type: "text_delta", agent: "code", delta: "# 结果\n\n" },
    { type: "text_delta", agent: "code", delta: "已完成。" },
    { type: "done", messageId: "answer" },
  ];
  let state = emptyChatProgress();
  const delivered: AgentStreamEvent[] = [];
  const buffer = createChatEventBuffer(
    (events) => {
      delivered.push(...events);
      state = events.reduce(reduceChatProgress, state);
    },
    { signal: new AbortController().signal },
  );
  for (const event of original) buffer.push(event);
  assert.deepEqual(state, original.reduce(reduceChatProgress, emptyChatProgress()));
  assert.equal(state.phase, "idle");
  assert.equal(delivered.at(-1)?.type, "done");
  t.mock.timers.tick(100);
  assert.deepEqual(state, original.reduce(reduceChatProgress, emptyChatProgress()));
  buffer.dispose();
});

test("terminal, approval, and phase events flush earlier text synchronously", () => {
  const boundaries: AgentStreamEvent[] = [
    { type: "done", messageId: "answer" },
    { type: "error", message: "disconnected" },
    { type: "agent_end", agent: "code" },
    { type: "response_start", agent: "code" },
    { type: "approval_required", approvalId: "confirm", title: "确认", detail: "继续？" },
  ];
  for (const event of boundaries) {
    const batches: AgentStreamEvent[][] = [];
    const buffer = createChatEventBuffer((events) => batches.push(events), {
      signal: new AbortController().signal,
    });
    const text: AgentStreamEvent = { type: "text_delta", agent: "code", delta: "最后一段" };
    buffer.push(text);
    buffer.push(event);
    assert.deepEqual(batches, [[text, event]]);
    buffer.dispose();
  }
});

test("stop and EOF flush are idempotent and accept a final server delta", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: AgentStreamEvent[][] = [];
  const buffer = createChatEventBuffer((events) => batches.push(events), {
    signal: new AbortController().signal,
  });
  buffer.push({ type: "text_delta", agent: "code", delta: "停止前" });
  buffer.flush();
  buffer.push({ type: "text_delta", agent: "code", delta: "服务器最后一段" });
  buffer.flush();
  buffer.dispose();
  buffer.flush();
  t.mock.timers.tick(100);
  assert.deepEqual(batches, [
    [{ type: "text_delta", agent: "code", delta: "停止前" }],
    [{ type: "text_delta", agent: "code", delta: "服务器最后一段" }],
  ]);
});

test("aborted and unmounted streams discard pending and late events without affecting a new stream", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: AgentStreamEvent[][] = [];
  const oldController = new AbortController();
  const oldBuffer = createChatEventBuffer((events) => batches.push(events), {
    signal: oldController.signal,
  });
  oldBuffer.push({ type: "text_delta", agent: "code", delta: "旧请求" });
  oldController.abort();
  oldBuffer.push({ type: "done", messageId: "old" });
  oldBuffer.flush();
  const next = createChatEventBuffer((events) => batches.push(events), {
    signal: new AbortController().signal,
  });
  next.push({ type: "text_delta", agent: "code", delta: "新请求" });
  t.mock.timers.tick(40);
  assert.deepEqual(batches, [[{ type: "text_delta", agent: "code", delta: "新请求" }]]);
  next.push({ type: "text_delta", agent: "code", delta: "卸载前" });
  next.dispose();
  t.mock.timers.tick(100);
  assert.equal(batches.length, 1);
});

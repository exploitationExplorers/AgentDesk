import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import StepRow from "../src/interactive/StepRow.js";
import ApprovalCard from "../src/interactive/ApprovalCard.js";
import { resolveAccessibility } from "../src/interactive/theme.js";
import type { ToolStep } from "../src/interactive/types.js";
import { diffRows } from "../src/interactive/FileDiff.js";
import {
  createInitialSession,
  sessionReducer,
  turnsFromMessages,
} from "../src/interactive/chat-reducer.js";
import type { FileChange } from "@agentdesk/shared";

afterEach(cleanup);
const theme = resolveAccessibility({ tty: true, env: {}, settings: { "no-motion": true } });
const step: ToolStep = {
  kind: "tool",
  id: "edit",
  name: "fs.patch",
  agent: "code",
  done: true,
  args: { path: "src/map.ts", oldText: "count = 1", newText: "count = 2" },
  result: {
    change: {
      path: "src/map.ts",
      operation: "edit",
      additions: 1,
      deletions: 1,
      diff: "--- a/src/map.ts\n+++ b/src/map.ts\n@@ -20,3 +20,3 @@\n const before = true;\n-export const count = 1;\n+export const count = 2;\n const after = true;",
      truncated: false,
      beforeHash: "before",
      afterHash: "after",
    },
  },
};

test("编辑完成默认显示带行号的实际增删内容", () => {
  const instance = render(createElement(StepRow, { step, expanded: false, theme }));
  const frame = instance.lastFrame() ?? "";
  assert.match(frame, /src\/map.ts/);
  assert.match(frame, /21\s+-.*export const count = 1/);
  assert.match(frame, /21\s+\+.*export const count = 2/);
  assert.match(frame, /22\s+.*const after/);
  assert.doesNotMatch(frame, /beforeHash|afterHash/);
});

test("拒绝或失败的修改不显示成功差异", () => {
  const instance = render(
    createElement(StepRow, { step: { ...step, isError: true }, expanded: false, theme }),
  );
  assert.doesNotMatch(instance.lastFrame() ?? "", /export const count = 2/);
});

test("文件落盘事件立即显示卡片，工具结束与历史恢复不丢失差异", () => {
  const change = (step.result as { change: FileChange }).change;
  let state = sessionReducer(createInitialSession(), { type: "SUBMIT", message: "修改文件" });
  state = sessionReducer(state, {
    type: "tool_call",
    agent: "code",
    id: step.id,
    name: step.name,
    args: step.args,
  });
  state = sessionReducer(state, {
    type: "file_change",
    agent: "code",
    toolCallId: step.id,
    change,
  });
  const liveStep = state.live!.steps[0] as ToolStep;
  assert.equal(liveStep.done, false);
  assert.equal(liveStep.change, change);
  const instance = render(createElement(StepRow, { step: liveStep, expanded: false, theme }));
  assert.match(instance.lastFrame() ?? "", /21\s+\+.*export const count = 2/);
  const [restored] = turnsFromMessages([
    {
      role: "assistant",
      content: "完成",
      toolCalls: [{ id: step.id, name: step.name, args: step.args, result: step.result }],
    },
  ]);
  const history = render(
    createElement(StepRow, { step: restored!.steps[0] as ToolStep, expanded: false, theme }),
  );
  assert.match(history.lastFrame() ?? "", /export const count = 2/);
});

test("新文件、多 hunk 与无末尾换行的行号准确且控制码不会进入终端", () => {
  assert.deepEqual(
    diffRows(
      "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file",
    ),
    [
      { kind: "add", number: 1, text: "first" },
      { kind: "add", number: 2, text: "second" },
      { kind: "note", text: "文件末尾无换行" },
    ],
  );
  assert.deepEqual(
    diffRows("@@ -1 +1 @@\n-a\n+b\n@@ -100 +101 @@\n-\u001b[2Jold\n+new")
      .filter((row) => row.kind !== "note")
      .map((row) => [row.number, row.text]),
    [
      [1, "a"],
      [1, "b"],
      [100, "old"],
      [101, "new"],
    ],
  );
});

test("已处理审批收为一行，不重复大段命令详情", () => {
  const instance = render(
    createElement(ApprovalCard, {
      title: "执行命令：git add README.md",
      detail: "工作目录：example\n".repeat(30),
      resolved: true,
      approved: true,
    }),
  );
  const frame = instance.lastFrame() ?? "";
  assert.match(frame, /已批准/);
  assert.ok(frame.split("\n").length <= 1, frame);
  assert.doesNotMatch(frame, /工作目录/);
});

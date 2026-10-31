import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { Box, render } from "ink";
import { stripVTControlCharacters } from "node:util";
import LiveTurnView from "../src/interactive/LiveTurnView.js";
import InputBar from "../src/interactive/InputBar.js";
import StatusBar from "../src/interactive/StatusBar.js";
import { resolveAccessibility } from "../src/interactive/theme.js";
import type { Turn } from "../src/interactive/types.js";

class TerminalStream extends PassThrough {
  isTTY = true;
  isRaw = false;
  columns = 80;
  rows = 24;
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

const theme = resolveAccessibility({ tty: true, env: {}, settings: { "no-motion": true } });
function longTurn(approval: boolean): Turn {
  return {
    userMessage: "完善 README",
    text: approval ? "" : "模型输出\n".repeat(80),
    agent: "orchestrator",
    error: null,
    steps: [
      {
        kind: "tool",
        id: "parent",
        agent: "orchestrator",
        name: "agents.delegate",
        args: { agent: "code" },
        done: false,
      },
      { kind: "route", agent: "code", reason: "根据实际源码完善文档，保留已有改动。".repeat(40) },
      ...Array.from({ length: 50 }, (_, i) => ({
        kind: "tool" as const,
        id: `read-${i}`,
        agent: "code" as const,
        name: "fs.read",
        args: { path: `apps/cli/src/example-${i}.ts` },
        done: true,
        result: "内容\n".repeat(20),
      })),
      ...(approval
        ? [
            {
              kind: "approval" as const,
              approvalId: "edit",
              title: "修补文件 README.md",
              detail: Array.from(
                { length: 100 },
                (_, i) => `修改详情 ${i + 1}：这里是需要核对的文档内容。`,
              ).join("\n"),
              resolved: false,
            },
          ]
        : []),
    ],
  };
}

for (const [columns, rows] of [
  [80, 24],
  [40, 16],
]) {
  for (const approval of [false, true]) {
    test(`${columns}×${rows} 长委派${approval ? "审批" : "输出"}不超出窗口且可翻页`, async () => {
      const stdout = new TerminalStream();
      stdout.columns = columns!;
      stdout.rows = rows!;
      const stdin = new TerminalStream();
      const frames: string[] = [];
      stdout.on("data", (chunk: Buffer) => frames.push(stripVTControlCharacters(chunk.toString())));
      const live = longTurn(approval);
      if (!approval) {
        live.text = "";
        live.steps.push({
          kind: "tool",
          id: "large-edit",
          agent: "code",
          name: "fs.write",
          args: { path: "large.ts" },
          done: true,
          result: {
            change: {
              path: "large.ts",
              operation: "create",
              additions: 120,
              deletions: 0,
              diff:
                "--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1,120 @@\n" +
                Array.from(
                  { length: 120 },
                  (_, i) => `+const line${i + 1} = ${i + 1}; // 模型输出`,
                ).join("\n"),
              truncated: false,
              beforeHash: null,
              afterHash: "hash",
            },
          },
        });
      }
      const view = () =>
        createElement(
          Box,
          { flexDirection: "column" },
          createElement(LiveTurnView, { live, theme, expanded: true, maxRows: stdout.rows - 7 }),
          createElement(InputBar, { value: "", onChange() {}, onSubmit() {}, disabled: true }),
          createElement(StatusBar, {
            conversationId: "example",
            pendingApprovals: approval ? 1 : 0,
            busy: true,
            stepFocusActive: false,
            model: "gpt-6.1-sol",
          }),
        );
      const instance = render(view(), {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      try {
        await delay(100);
        const first = frames.at(-1)!;
        assert.ok(first.includes("PgUp/PgDn"), JSON.stringify(frames));
        assert.ok(first.split("\n").length < rows!, `实时区域撑出窗口：${first}`);
        assert.ok(first.includes("执行中"));
        if (approval) {
          assert.match(first, /修改详情[\s│]*1：/);
          assert.ok(first.includes("按 y 批准"));
        } else assert.match(first, /120\s+\+ const line120/, first);
        stdin.write(approval ? "\x1b[6~" : "\x1b[5~");
        await delay(80);
        const scrolled = frames.at(-1)!;
        assert.notEqual(scrolled, first, "翻页应移动可见内容");
        if (approval) {
          assert.doesNotMatch(scrolled, /修改详情[\s│]*1：/);
          assert.ok(scrolled.includes("按 y 批准"), "翻页时审批操作固定可见");
        }
        stdout.columns = 36;
        stdout.rows = 16;
        stdout.emit("resize");
        instance.rerender(view());
        await delay(80);
        assert.ok(frames.at(-1)!.includes("执行中"));
        assert.ok(frames.at(-1)!.split("\n").length < stdout.rows);
      } finally {
        instance.unmount();
        await instance.waitUntilExit();
        stdout.destroy();
        stdin.destroy();
      }
    });
  }
}

test("长步骤列表的键盘焦点滚入视口，退出焦点后继续跟随末尾", async () => {
  const stdout = new TerminalStream();
  const stdin = new TerminalStream();
  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(stripVTControlCharacters(chunk.toString())));
  const live = longTurn(false);
  const view = (id: string | null) =>
    createElement(LiveTurnView, {
      live,
      theme,
      expanded: false,
      maxRows: 17,
      stepFocusActive: id !== null,
      focusedStepId: id,
    });
  const instance = render(view(null), {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await delay(100);
    assert.ok(frames.at(-1)!.includes("模型输出"));
    for (const id of ["parent", "read-49", "read-0"]) {
      instance.rerender(view(id));
      await delay(100);
      const frame = frames.at(-1)!;
      assert.ok(frame.includes("▌"), frame);
      assert.ok(frame.includes(id === "parent" ? "交给助手" : `example-${id.slice(5)}.ts`), frame);
      assert.ok(frame.split("\n").length <= 17);
    }
    instance.rerender(view(null));
    await delay(100);
    assert.ok(frames.at(-1)!.includes("模型输出"));
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    stdout.destroy();
    stdin.destroy();
  }
});

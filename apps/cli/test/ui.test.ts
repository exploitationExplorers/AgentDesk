import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { configureUi, createUi, loadPrompts, nextCommand } from "../src/ui.js";
import { question, select } from "../src/terminal.js";

/** 只模拟交互组件实际使用的 TTY 属性，其余读写行为沿用真实 Node stream。 */
class TtyFixture extends PassThrough {
  isTTY = true;
  isRaw = false;
  columns = 80;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
  asInput(): ReadStream {
    return this as unknown as ReadStream;
  }
  asOutput(): WriteStream {
    return this as unknown as WriteStream;
  }
}

test("管道、纯文本和 NO_COLOR 不输出颜色；dumb 终端不启用光标交互", async () => {
  for (const settings of [
    { tty: false },
    { tty: true, plain: true },
    { tty: true, env: { NO_COLOR: "" } },
    { tty: true, "no-color": true },
    { tty: true, env: { TERM: "dumb" } },
  ]) {
    let output = "";
    const stream = {
      isTTY: settings.tty,
      write: (text: string) => {
        output += text;
      },
    };
    const ui = createUi({ stream, env: {}, ...settings });
    ui.header("本地引擎", "0.1.0");
    ui.card("状态", [["目录", "D:/包含空格 的路径"]]);
    ui.success("已启动");
    ui.error("未就绪");
    assert.ok(!output.includes("\x1b"));
    assert.ok(output.includes("D:/包含空格 的路径"));
    if (!settings.tty || settings.plain || settings.env?.TERM === "dumb") {
      assert.equal(ui.interactive, false);
      await ui.task("启动", async () => {});
      assert.ok(!output.includes("\x1b"));
    }
  }
});

test("Vite+ 菜单响应方向键，完成后收起选项，取消恢复终端", async () => {
  configureUi({});
  await loadPrompts();
  for (const cancel of [false, true]) {
    const input = new TtyFixture();
    let transcript = "";
    const output = new TtyFixture();
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const result = select(
      "API 协议",
      [
        { label: "OpenAI", value: "openai-completions" },
        { label: "Claude", value: "anthropic-messages" },
      ],
      { input: input.asInput(), output: output.asOutput(), env: { TERM: "xterm" } },
    );
    // 等提示真正挂上键盘监听后再发方向键，否则 Ctrl+C/Enter 会被吞掉。
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (transcript.includes("API 协议")) resolve(undefined);
        else if (Date.now() - started > 2000) reject(new Error("菜单未在超时内出现"));
        else setTimeout(check, 5);
      };
      check();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write("\x1b[B");
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(cancel ? "\x03" : "\r");
    if (cancel) {
      await assert.rejects(result, /已取消/);
      // vite-plus-prompts 取消收起后用 x 标记；旧版是 ■/◇。
      assert.match(transcript, /x API 协议/);
    } else {
      assert.equal(await result, "anthropic-messages");
      assert.match(transcript, /o API 协议/);
      assert.ok(transcript.includes("Claude"));
    }
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("keypress"), 0);
    assert.ok(transcript.includes("API 协议"));
    input.destroy();
    output.destroy();
  }
});

test("Vite+ 输入框隐藏密钥；空值验证后可以继续输入", async () => {
  await loadPrompts();
  const input = new TtyFixture();
  const output = new TtyFixture();
  output.columns = 45;
  let transcript = "";
  let retried = false;
  output.on("data", (chunk) => {
    transcript += chunk.toString();
    if (transcript.includes("请输入密钥") && !retried) {
      retried = true;
      setImmediate(() => input.write("ui-secret-test-value\r"));
    }
  });
  const result = question("API Key", {
    secret: true,
    validate: (value) => (value?.trim() ? undefined : "请输入密钥"),
    input: input.asInput(),
    output: output.asOutput(),
    env: { TERM: "xterm" },
  });
  setImmediate(() => input.write("\r"));
  assert.equal(await result, "ui-secret-test-value");
  assert.equal(retried, true);
  assert.ok(!transcript.includes("ui-secret-test-value"));
  assert.ok(transcript.includes("▪"));
  assert.equal(input.isRaw, false);
  input.destroy();
  output.destroy();
});

test("JSON 状态输出可直接解析，且无 banner、颜色或 stderr 噪声", () => {
  const home = mkdtempSync(join(tmpdir(), "agentdesk-json-ui-"));
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      entry,
      "status",
      "--json",
      "--no-color",
      "--data-dir",
      home,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).status, "stopped");
  assert.ok(!result.stdout.includes("\x1b"));
});

test("下一步示例保留自定义数据目录并引用 shell 特殊字符", () => {
  assert.equal(
    nextCommand("init", "D:/Agent Desk/$data's", "win32"),
    "agentdesk init --data-dir 'D:/Agent Desk/$data''s'",
  );
  assert.equal(
    nextCommand("init", "/tmp/data's", "linux"),
    "agentdesk init --data-dir '/tmp/data'\\''s'",
  );
});

test("减少动态效果时欢迎与步骤没有动画，图标可单独关闭", async () => {
  for (const settings of [
    { "no-motion": true },
    { env: { AGENTDESK_REDUCED_MOTION: "1" } },
    { env: { CI: "true" } },
    { env: { ACCESSIBLE: "1" } },
  ]) {
    let output = "";
    const ui = createUi({
      stream: {
        isTTY: true,
        write: (text) => {
          output += text;
        },
      },
      env: {},
      ...settings,
    });
    assert.equal(ui.motion, false);
    await ui.welcome("配置模型");
    await ui.advance(1, 4, "协议已选择");
    await ui.task("保存", async () => {});
    assert.ok(output.includes("欢迎使用 AgentDesk"));
    assert.ok(output.includes("1/4"));
    assert.ok(!output.includes("\r"));
  }
  const noEmoji = createUi({ stream: { isTTY: true, write() {} }, env: {}, "no-emoji": true });
  assert.equal(noEmoji.icon("👋"), "");
  assert.equal(noEmoji.interactive, true);
});

test("欢迎动画被 Ctrl+C 中断后清除临时行与信号监听器", async () => {
  let output = "";
  let interrupted = false;
  const listeners = process.listenerCount("SIGINT");
  const ui = createUi({
    stream: {
      isTTY: true,
      write(text) {
        output += text;
        if (text.startsWith("\r") && !interrupted) {
          interrupted = true;
          setImmediate(() => process.emit("SIGINT"));
        }
      },
    },
    env: {},
  });
  await assert.rejects(ui.welcome("预览"), /已取消配置/);
  assert.equal(process.listenerCount("SIGINT"), listeners);
  assert.ok(output.endsWith("\r\x1b[2K"));
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCommand } from "../src/args.mjs";

test("参数校验拒绝拼错命令、无关参数和错误端口", () => {
  for (const argv of [
    ["strat"],
    ["stop", "--port", "1234"],
    ["start", "--port", "-1"],
    ["start", "--port", "65536"],
    ["logs", "--lines", "0"],
    ["approve"],
    ["stop", "extra"],
  ]) {
    assert.throws(() => parseCommand(argv));
  }
  assert.equal(parseCommand(["start", "--port", "0", "-f"]).values.foreground, true);
  assert.equal(parseCommand(["chat", "中文内容", "--agent", "code"]).positionals[0], "中文内容");
});

test("chat 不带消息不再强制报错，交由交互式会话或一次性路径决定", () => {
  const { command, positionals } = parseCommand(["chat"]);
  assert.equal(command, "chat");
  assert.deepEqual(positionals, []);
});

test("run/tasks/inspect/cancel/resume 的参数解析与位置参数校验", () => {
  assert.equal(parseCommand(["run", "修复登录页报错"]).positionals[0], "修复登录页报错");
  assert.equal(
    parseCommand(["run", "继续", "--conversation", "task-1", "--plan"]).values.plan,
    true,
  );
  assert.equal(parseCommand(["tasks", "--status", "running"]).values.status, "running");
  assert.equal(parseCommand(["inspect", "task-1", "--follow"]).positionals[0], "task-1");
  assert.equal(parseCommand(["resume", "task-1", "--message", "重试"]).values.message, "重试");
  assert.equal(parseCommand(["cancel", "task-1", "--json"]).values.json, true);
  for (const argv of [
    ["inspect"],
    ["inspect", "task-1", "task-2"],
    ["cancel"],
    ["cancel", "task-1", "task-2"],
    ["resume"],
    ["tasks", "extra"],
    ["run", "目标", "--status", "running"],
  ]) {
    assert.throws(() => parseCommand(argv));
  }
});

test("help 和 version 不创建数据目录、不加载运行时或原生依赖", () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-cli-help-"));
  const home = join(root, "not-created");
  const entry = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  for (const flag of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [entry, flag, "--data-dir", home], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
    assert.equal(existsSync(home), false);
  }
});

test("裸执行（不带任何参数）在非 TTY 环境下行为不变：打印 HELP，不创建数据目录、不启动服务", () => {
  // 子进程 stdio 默认走管道（非 TTY），用来验证"裸执行+真实交互终端才直接进对话"的新分支
  // 不会误伤脚本/CI 场景；timeout 兜底，避免逻辑有误时在非交互环境里卡住等待输入。
  const root = mkdtempSync(join(tmpdir(), "agentdesk-cli-bare-"));
  const home = join(root, "not-created");
  const entry = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    timeout: 10_000,
    input: "",
    env: { ...process.env, AGENTDESK_CLI_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("用法：agentdesk"));
  assert.equal(existsSync(home), false);
});

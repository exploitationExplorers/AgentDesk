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

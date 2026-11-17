import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionReporter,
  transcriptEntries,
  watchTaskTranscript,
} from "../src/team/execution.js";
import { teamExecutionText, type TeamExecutionInput } from "@agentdesk/shared";
import { runTeamProcess } from "../src/team/runner.js";

test("仅投影可见 Agent 回复与工具调用，不共享隐藏推理和用户消息", () => {
  assert.deepEqual(
    transcriptEntries("codex", {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "analysis",
        content: [{ type: "output_text", text: "hidden" }],
      },
    }),
    [],
  );
  assert.deepEqual(
    transcriptEntries("codex", {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "private" }],
      },
    }),
    [],
  );
  assert.deepEqual(
    transcriptEntries("claude", {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "正在检查接口" },
          { type: "tool_use", name: "Bash", input: { command: "git status" } },
        ],
      },
    }),
    [
      { kind: "message", text: "正在检查接口" },
      { kind: "command", text: "Bash\ngit status" },
    ],
  );
});
test("共享输出过滤已知值、认证行、私钥与控制字符", () => {
  const key = "sk-" + "z".repeat(32);
  const begin = "-----BEGIN " + "PRIVATE KEY-----";
  const end = "-----END " + "PRIVATE KEY-----";
  const output = teamExecutionText(
    `正常日志\nAPI_KEY=${key}\n${begin}\nopaque-private-data\n${end}\nabc-opaque-credential\n\x1b[31m完成\x1b[0m`,
    ["abc-opaque-credential"],
  );
  assert.ok(!output.includes(key));
  assert.ok(!output.includes("opaque-private-data"));
  assert.ok(!output.includes("abc-opaque-credential"));
  assert.match(output, /正常日志/);
  assert.match(output, /完成/);
});
test("批次失败沿用原事件 ID 重试，顺序稳定且先做本机密钥过滤", async () => {
  const batches: TeamExecutionInput[][] = [];
  let fail = true;
  const reporter = executionReporter(
    async (entries) => {
      batches.push(structuredClone(entries));
      if (fail) {
        fail = false;
        throw Error("offline");
      }
    },
    ["opaque-secret-value"],
  );
  reporter.emit({ kind: "output", text: "hello opaque-secret-value" });
  await reporter.flush();
  await reporter.flush();
  await reporter.close();
  assert.equal(batches.length, 2);
  assert.equal(batches[0]![0]!.id, batches[1]![0]!.id);
  assert.ok(!batches[1]![0]!.text.includes("opaque-secret-value"));
});
test("日志跟随只认任务 worktree，支持追加的分片中文 JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-transcript-"));
  const events: Array<{ kind: string; text: string }> = [];
  const cwd = join(root, "worktree");
  const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n";
  const message = (text: string) =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "commentary",
        content: [{ type: "output_text", text }],
      },
    }) + "\n";
  await writeFile(
    join(root, "other.jsonl"),
    meta(join(root, "unrelated")) + message("其它会话不能共享"),
  );
  const file = join(root, "task.jsonl");
  await writeFile(file, meta(cwd) + message("正在分析接口"));
  const stop = watchTaskTranscript({
    executor: "codex",
    cwd,
    root,
    startedAt: Date.now() - 100,
    emit: (e) => events.push(e),
  });
  try {
    await new Promise((r) => setTimeout(r, 1000));
    const next = Buffer.from(message("正在修改中文文件"));
    const split = next.indexOf(Buffer.from("中")) + 1;
    await appendFile(file, next.subarray(0, split));
    await new Promise((r) => setTimeout(r, 800));
    await appendFile(file, next.subarray(split));
    await stop();
    assert.deepEqual(
      events.map((e) => e.text),
      ["正在分析接口", "正在修改中文文件"],
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("普通进程输出在共享时仍回显本机，跨行私钥不进入共享记录", async () => {
  const output: string[] = [];
  const code =
    "console.log('检查开始');console.log('-----BEGIN ' + 'PRIVATE KEY-----');console.log('private-base64-body');console.log('-----END ' + 'PRIVATE KEY-----');console.log('完成');";
  assert.equal(
    await runTeamProcess(
      process.execPath,
      ["-e", code],
      process.cwd(),
      new AbortController().signal,
      (text) => output.push(text),
    ),
    0,
  );
  assert.ok(output.includes("检查开始"));
  assert.ok(output.includes("完成"));
  assert.ok(!output.some((x) => x.includes("private-base64-body")));
});

/** 验证已安装发行包的真实服务链路：node package-smoke.mjs <已安装包目录>。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apiRequest } from "../src/client.mjs";
import { readState } from "../src/state.mjs";

const installedPackage = resolve(process.argv[2] ?? "apps/cli");
const entry = join(installedPackage, "dist/index.mjs");
assert.ok(existsSync(entry), "请先构建或安装 CLI 发行包。");
const home = mkdtempSync(join(tmpdir(), "agentdesk-package-smoke-"));
const observations = { modelCalls: 0, approvalDenied: false };

function command(args, { expectedCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, "--data-dir", home], {
      cwd: home,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTDESK_SMOKE_KEY: "local-integration-key" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时：${args[0]}`));
    }, 25_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== expectedCode)
        reject(new Error(`命令 ${args[0]} 退出 ${code}：${stderr || stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.url, "/v1/chat/completions");
  observations.modelCalls++;
  if (JSON.stringify(body.messages).includes("intentional-model-failure")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "intentional model rejection", type: "invalid_request_error" },
      }),
    );
    return;
  }
  const toolResult = body.messages.findLast((message) => message.role === "tool");
  const isMemory = !body.tools?.length;
  const tool = body.tools?.find((tool) => /projects.*pull/.test(tool.function.name));
  const makeChunk = (delta, finishReason = null) => ({
    id: "cli-smoke-response",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "local-smoke-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (!isMemory && !toolResult && tool) {
    res.write(
      `data: ${JSON.stringify(makeChunk({ role: "assistant", tool_calls: [{ index: 0, id: "smoke-call", type: "function", function: { name: tool.function.name, arguments: '{"project":"smoke-denied"}' } }] }))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(makeChunk({}, "tool_calls"))}\n\n`);
  } else {
    if (toolResult)
      observations.approvalDenied = /拒绝|denied|rejected/i.test(JSON.stringify(toolResult));
    res.write(
      `data: ${JSON.stringify(makeChunk({ role: "assistant", content: isMemory ? '{"memories":[]}' : "CLI 集成验证成功" }))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(makeChunk({}, "stop"))}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

try {
  await command(["--help"]);
  assert.equal(existsSync(join(home, "service.json")), false);
  await command(["status", "--json"], { expectedCode: 1 });
  await command(["start", "--port", "0"]);
  const initial = readState(home);
  assert.ok(initial.port > 0);
  const unauthorized = await fetch(`http://127.0.0.1:${initial.port}/api/health`);
  assert.equal(unauthorized.status, 401);
  const skills = await (await apiRequest(initial, "/skills")).json();
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "bt-deploy",
    "project-triage",
    "tech-explain",
  ]);
  await command(["start"]);
  assert.equal(readState(home).pid, initial.pid);
  await command([
    "init",
    "--base-url",
    `http://127.0.0.1:${model.address().port}/v1`,
    "--model",
    "local-smoke-model",
    "--api-key-env",
    "AGENTDESK_SMOKE_KEY",
  ]);
  const providers = await (await apiRequest(initial, "/providers")).json();
  assert.equal(providers[0].hasKey, true);
  assert.equal(providers[0].apiKey, undefined);
  assert.equal(JSON.stringify(providers).includes("local-integration-key"), false);
  const chat = await command(["chat", "验证审批拒绝和流式输出", "--agent", "project", "--json"]);
  const events = chat.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "approval_required"));
  assert.ok(
    events.some((event) => event.type === "text_delta" && event.delta.includes("CLI 集成验证成功")),
  );
  assert.equal(events.at(-1).type, "done");
  assert.equal(observations.approvalDenied, true, "非交互审批必须拒绝真实 Agent 工具调用。");
  const failed = await command(
    ["chat", "intentional-model-failure", "--agent", "project", "--json"],
    { expectedCode: 1 },
  );
  assert.ok(failed.stderr.includes("intentional model rejection"));
  const doctor = JSON.parse((await command(["doctor", "--json"])).stdout);
  assert.equal(doctor.ok, true);
  await command(["restart"]);
  const restarted = readState(home);
  assert.notEqual(restarted.instanceId, initial.instanceId);
  assert.equal(restarted.port, initial.port);
  await command(["logs"]);
  assert.equal(readFileSync(join(home, "daemon.log"), "utf8").includes(initial.token), false);
  await command(["stop"]);
  assert.equal(readState(home), null);
  await command(["status"], { expectedCode: 1 });
  const foreground = spawn(
    process.execPath,
    [entry, "start", "--foreground", "--port", "0", "--data-dir", home],
    {
      cwd: home,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  const foregroundExit = new Promise((resolve, reject) => {
    foreground.once("error", reject);
    foreground.once("exit", (code) => resolve(code));
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = readState(home);
      if (state?.port) {
        assert.equal(state.mode, "foreground");
        ready = true;
        break;
      }
      await delay(100);
    }
    assert.equal(ready, true, "前台服务需要就绪。");
    await command(["stop"]);
    assert.equal(await foregroundExit, 0);
  } finally {
    if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill();
  }
  console.info(
    JSON.stringify(
      {
        ok: true,
        installedPackage,
        modelCalls: observations.modelCalls,
        checks: [
          "help",
          "auth",
          "skills",
          "background",
          "duplicate-start",
          "init",
          "encrypted-key",
          "streaming-chat",
          "approval-denied",
          "model-error-exit-code",
          "doctor",
          "restart",
          "logs",
          "stop",
          "foreground",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await command(["stop"]);
  } finally {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  }
}

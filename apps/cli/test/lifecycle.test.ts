import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runningState, serviceStatus, startService, stopService } from "../src/lifecycle.js";
import { claimState, readState } from "../src/state.js";

const workerPath = fileURLToPath(new URL("./fixtures/service.mjs", import.meta.url));
const homeDir = () => mkdtempSync(join(tmpdir(), "agentdesk-cli-lifecycle-"));

test("后台启动、重复启动和认证关闭管理同一真实子进程", async () => {
  const home = homeDir();
  try {
    const first = await startService(home, { workerPath, port: 0 });
    assert.equal(first.status, "running");
    assert.notEqual(first.state.pid, process.pid);
    await assert.rejects(
      startService(home, { workerPath, port: first.state.port === 1 ? 2 : 1 }),
      /指定端口/,
    );
    const second = await startService(home, { workerPath });
    assert.ok(second.state);
    assert.equal(second.existing, true);
    assert.equal(second.state.pid, first.state.pid);
    assert.equal(await stopService(home), true);
    assert.equal(readState(home), null);
    assert.equal((await serviceStatus(home)).status, "stopped");
    assert.equal(await stopService(home), false);
  } finally {
    await stopService(home);
  }
});

test("读轮询期间两个并发 start 最多保留一个实例，状态始终完整", async () => {
  const home = homeDir();
  const readErrors: unknown[] = [];
  let reads = 0;
  const reader = setInterval(() => {
    try {
      const state = readState(home);
      if (state) reads++;
    } catch (error) {
      readErrors.push(error);
    }
  }, 1);
  try {
    const results = await Promise.allSettled([
      startService(home, { workerPath }),
      startService(home, { workerPath }),
    ]);
    const running = results.filter((result) => result.status === "fulfilled");
    assert.ok(running.length >= 1);
    assert.equal(
      new Set(
        running.map((result) => {
          assert.ok(result.value.state);
          return result.value.state.pid;
        }),
      ).size,
      1,
    );
    assert.equal((await serviceStatus(home)).status, "running");
    assert.ok(reads > 0);
    assert.deepEqual(readErrors, []);
  } finally {
    clearInterval(reader);
    await stopService(home);
  }
});

test("失联记录指向仍存活进程时不强杀也不覆盖", async () => {
  const home = homeDir();
  const instanceId = randomUUID();
  claimState(home, {
    schemaVersion: 1,
    instanceId,
    pid: process.pid,
    token: randomBytes(32).toString("hex"),
    port: 0,
    mode: "foreground",
    version: "fixture",
    startedAt: new Date().toISOString(),
  });
  await assert.rejects(stopService(home), /拒绝/);
  await assert.rejects(startService(home, { workerPath }), /已有 CLI 进程/);
  assert.equal(readState(home)?.instanceId, instanceId);
});

test("runningState 在服务未启动时自动拉起真实子进程并返回其 state", async () => {
  const home = homeDir();
  try {
    assert.equal((await serviceStatus(home)).status, "stopped");
    const state = await runningState(home, workerPath);
    assert.notEqual(state.pid, process.pid);
    assert.equal((await serviceStatus(home)).status, "running");
  } finally {
    await stopService(home);
  }
});

test("runningState 在服务已运行时直接复用，不创建第二个实例", async () => {
  const home = homeDir();
  try {
    const started = await startService(home, { workerPath });
    assert.ok(started.state);
    const state = await runningState(home, workerPath);
    assert.equal(state.pid, started.state.pid);
    assert.equal(state.instanceId, started.state.instanceId);
  } finally {
    await stopService(home);
  }
});

test("损坏状态文件明确失败，不静默覆盖", async () => {
  const home = homeDir();
  writeFileSync(join(home, "service.json"), '{"token":"private-value"}');
  assert.throws(() => readState(home), /格式无效/);
});

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claimState, publishState, readState, type CliState } from "../src/state.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agentdesk-state-publish-"));
  const state: CliState = {
    schemaVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    port: 0,
    token: randomBytes(32).toString("hex"),
    mode: "background",
    version: "test",
    startedAt: new Date().toISOString(),
  };
  claimState(home, state);
  return { home, state };
}

test("Windows 共享冲突退避后原子发布，等待期间仍可读取原状态", async () => {
  const { home, state } = fixture();
  const conflicts = ["EPERM", "EACCES", "EBUSY"];
  let attempts = 0;
  const waits: number[] = [];
  await publishState(
    home,
    { ...state, port: 1234 },
    {
      platform: "win32",
      async rename(source, destination) {
        assert.equal(dirname(source), dirname(destination));
        const code = conflicts[attempts++];
        if (code) throw Object.assign(new Error("sharing violation"), { code });
        await rename(source, destination);
      },
      async wait(milliseconds) {
        waits.push(milliseconds);
        assert.deepEqual(readState(home), state);
      },
    },
  );
  assert.equal(attempts, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits.every((milliseconds) => milliseconds > 0 && milliseconds <= 250));
  assert.equal(readState(home)?.port, 1234);
  assert.deepEqual(readdirSync(home), ["service.json"]);
});

test("非 Windows 或非共享冲突立即失败并清理临时文件", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["win32", "ENOSPC"],
  ] as const) {
    const { home, state } = fixture();
    const expected = Object.assign(new Error("rename failed"), { code });
    let attempts = 0;
    await assert.rejects(
      publishState(
        home,
        { ...state, port: 1234 },
        {
          platform,
          async rename() {
            attempts++;
            throw expected;
          },
          async wait() {
            assert.fail("不能重试不可恢复错误");
          },
        },
      ),
      (error) => error === expected,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(readState(home), state);
    assert.deepEqual(readdirSync(home), ["service.json"]);
  }
});

test("持续 Windows 冲突有重试上限，保留目标并清理临时文件", async () => {
  const { home, state } = fixture();
  const expected = Object.assign(new Error("locked"), { code: "EBUSY" });
  let attempts = 0;
  await assert.rejects(
    publishState(
      home,
      { ...state, port: 1234 },
      {
        platform: "win32",
        async rename() {
          attempts++;
          throw expected;
        },
        async wait() {},
      },
    ),
    (error) => error === expected,
  );
  assert.ok(attempts > 1 && attempts <= 10);
  assert.deepEqual(readState(home), state);
  assert.deepEqual(readdirSync(home), ["service.json"]);
});

test("退避期间实例所有权改变，后续不覆盖其他实例", async () => {
  const { home, state } = fixture();
  const other = { ...state, instanceId: randomUUID(), token: randomBytes(32).toString("hex") };
  let attempts = 0;
  await assert.rejects(
    publishState(
      home,
      { ...state, port: 1234 },
      {
        platform: "win32",
        async rename() {
          attempts++;
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        },
        async wait() {
          writeFileSync(join(home, "service.json"), JSON.stringify(other));
        },
      },
    ),
    /所有权已改变/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(readState(home), other);
  assert.deepEqual(readdirSync(home), ["service.json"]);
});

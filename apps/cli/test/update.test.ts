import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isNewerVersion, pendingUpdate } from "../src/update.js";

function home() {
  return mkdtempSync(join(tmpdir(), "agentdesk-update-"));
}

function fakeFetch(version: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ version }), { status })) as unknown as typeof fetch;
}

test("只把更高的数字版本视为可更新", () => {
  assert.equal(isNewerVersion("0.1.2", "0.1.1"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.1"), false);
  assert.equal(isNewerVersion("0.1.0", "0.1.1"), false);
  assert.equal(isNewerVersion("0.0.0-stage", "0.1.1"), false);
});

test("registry 有新版本时返回该版本，并记下检查时间", async () => {
  const directory = home();
  const latest = await pendingUpdate({
    current: "0.1.1",
    name: "chuxin-agentdesk",
    home: directory,
    fetchImpl: fakeFetch("0.1.2"),
    now: () => 1_000,
  });
  assert.equal(latest, "0.1.2");
  const cache = JSON.parse(readFileSync(join(directory, "update-check.json"), "utf8"));
  assert.equal(cache.latest, "0.1.2");
  assert.equal(cache.checkedAt, 1_000);
});

test("已是最新、请求失败或选择忽略该版本时不提示", async () => {
  const current = home();
  assert.equal(
    await pendingUpdate({
      current: "0.1.2",
      name: "chuxin-agentdesk",
      home: current,
      fetchImpl: fakeFetch("0.1.2"),
    }),
    null,
  );
  const failed = home();
  assert.equal(
    await pendingUpdate({
      current: "0.1.1",
      name: "chuxin-agentdesk",
      home: failed,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }),
    null,
  );
  const skipped = home();
  mkdirSync(skipped, { recursive: true });
  writeFileSync(join(skipped, "update-skip"), "0.1.2");
  const start = 5_000;
  assert.equal(
    await pendingUpdate({
      current: "0.1.1",
      name: "chuxin-agentdesk",
      home: skipped,
      fetchImpl: fakeFetch("0.1.2"),
      now: () => start,
    }),
    null,
  );
  assert.equal(
    await pendingUpdate({
      current: "0.1.1",
      name: "chuxin-agentdesk",
      home: skipped,
      fetchImpl: fakeFetch("0.1.3"),
      now: () => start + 60 * 60 * 1000 + 1,
    }),
    "0.1.3",
  );
});

test("一小时内复用上次结果，不再请求 registry", async () => {
  const directory = home();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ version: "0.2.0" }));
  }) as unknown as typeof fetch;
  await pendingUpdate({
    current: "0.1.1",
    name: "chuxin-agentdesk",
    home: directory,
    fetchImpl,
    now: () => 10_000,
  });
  const again = await pendingUpdate({
    current: "0.1.1",
    name: "chuxin-agentdesk",
    home: directory,
    fetchImpl,
    now: () => 10_000 + 30 * 60 * 1000,
  });
  assert.equal(again, "0.2.0");
  assert.equal(calls, 1);
});

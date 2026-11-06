import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { startAutoloopRuntime, type AutoloopRuntime } from "../src/index";
import { ensurePrivateDirectory } from "../src/private-directory";

const credentials = () => ({
  owner: randomBytes(32).toString("base64url"),
  source: randomBytes(32).toString("base64url"),
  worker: randomBytes(32).toString("base64url"),
  channel: randomBytes(32).toString("base64url"),
});
const runtimeOptions = {
  ...(process.env.AGENTDESK_AUTOLOOP_TEST_HOST
    ? { hostPath: resolve(process.env.AGENTDESK_AUTOLOOP_TEST_HOST) }
    : {}),
  ...(process.env.AGENTDESK_AUTOLOOP_TEST_NODE
    ? { nodePath: resolve(process.env.AGENTDESK_AUTOLOOP_TEST_NODE) }
    : {}),
};
function rules(cwd: string) {
  return {
    timezone: "Asia/Shanghai",
    sources: { agentdesk: { name: "AgentDesk" } },
    agents: {
      agentdesk: { name: "AgentDesk", worker: "agentdesk", use: "agentdesk", access: "edit" },
    },
    channels: { agentdesk: { name: "AgentDesk", answerers: ["owner"] } },
    rules: [
      {
        name: "report",
        when: { source: "agentdesk", types: ["report.requested"] },
        to: "agentdesk",
        cwd,
        prompt: "生成报告",
        parallel: 2,
      },
    ],
  };
}
async function call(hub: AutoloopRuntime, token: string, path: string, body?: unknown) {
  const response = await fetch(hub.baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("真实 TCP 协议闭环、卡片重启续办和规则替换", { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-hub-中文 空格-"));
  const keys = credentials();
  const config = rules(dataDir);
  let hub = await startAutoloopRuntime({
    ...runtimeOptions,
    dataDir,
    rules: config,
    credentials: keys,
  });
  try {
    if (process.platform === "win32") {
      const aclScript = [
        "$ProgressPreference = 'SilentlyContinue'",
        "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$directory = [System.IO.Directory]::GetAccessControl($env:AGENTDESK_TEST_ACL_DIR)",
        "$key = [System.IO.File]::GetAccessControl([System.IO.Path]::Combine($env:AGENTDESK_TEST_ACL_DIR, 'master.key'))",
        "$rules = $key.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
        "@{ identity = $identity; protected = $directory.AreAccessRulesProtected; allowed = @($rules | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress",
      ].join("; ");
      const permissions = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(aclScript, "utf16le").toString("base64"),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, AGENTDESK_TEST_ACL_DIR: dataDir },
          },
        ),
      );
      assert.equal(permissions.protected, true);
      assert.deepEqual(permissions.allowed.sort(), [permissions.identity, "S-1-5-18"].sort());
      assert.throws(() => ensurePrivateDirectory("D:relative"), /绝对路径/);
    }
    await assert.rejects(
      startAutoloopRuntime({ ...runtimeOptions, dataDir, rules: config, credentials: keys }),
      /已有 Autoloop Hub/,
    );
    const accepted = await call(hub, keys.source, "/v1/events", {
      id: "one",
      type: "report.requested",
      subject: "weekly",
    });
    const repeated = await call(hub, keys.source, "/v1/events", {
      id: "one",
      type: "report.requested",
      subject: "weekly",
    });
    assert.equal(repeated.event, accepted.event);
    assert.equal(repeated.duplicate, true);
    const first = (await call(hub, keys.worker, "/v1/work?claim=first&wait=0&capacity=1")).job;
    assert.equal(first.rule.cwd, dataDir);
    await call(hub, first.token, `/v1/runs/${first.run}/started`, { session: "conversation-one" });
    const result = {
      outcome: "done",
      session: "conversation-one",
      summary: "等待选择",
      ask: [{ key: "scope", title: "汇报重点", text: "请选择重点", options: ["项目", "风险"] }],
    };
    await call(hub, first.token, `/v1/runs/${first.run}/result`, result);
    assert.equal(
      (await call(hub, first.token, `/v1/runs/${first.run}/result`, result)).duplicate,
      true,
    );
    const card = (await call(hub, keys.channel, "/v1/cards/next?wait=0")).card;
    assert.ok(card.id);
    await hub.stop();
    await assert.rejects(hub.updateRules(config), /已停止/);
    const databaseHash = () =>
      createHash("sha256")
        .update(readFileSync(join(dataDir, "hub.db")))
        .digest("hex");
    const beforeUpgrade = databaseHash();
    const versionFile = join(dataDir, "data-version.json");
    const version = readFileSync(versionFile, "utf8");
    writeFileSync(
      versionFile,
      JSON.stringify({ schemaVersion: 999, upstreamCommit: "incompatible" }),
    );
    await assert.rejects(
      startAutoloopRuntime({ ...runtimeOptions, dataDir, rules: config, credentials: keys }),
      /数据格式/,
    );
    assert.equal(databaseHash(), beforeUpgrade);
    writeFileSync(versionFile, version);
    renameSync(join(dataDir, "master.key"), join(dataDir, "master-backup.key"));
    await assert.rejects(
      startAutoloopRuntime({ ...runtimeOptions, dataDir, rules: config, credentials: keys }),
      /主密钥/,
    );
    assert.equal(databaseHash(), beforeUpgrade);
    renameSync(join(dataDir, "master-backup.key"), join(dataDir, "master.key"));
    hub = await startAutoloopRuntime({
      ...runtimeOptions,
      dataDir,
      rules: config,
      credentials: keys,
    });
    const answer = await call(hub, keys.owner, `/v1/cards/${card.id}/answer`, { choice: 0 });
    assert.equal(answer.changed, true);
    assert.equal(
      (await call(hub, keys.owner, `/v1/cards/${card.id}/answer`, { choice: 1 })).changed,
      false,
    );
    const next = (await call(hub, keys.worker, "/v1/work?claim=next&wait=0&capacity=1")).job;
    assert.equal(next.session, "conversation-one");
    assert.equal(next.context.answers[0].choice, 0);
    await call(hub, next.token, `/v1/runs/${next.run}/result`, {
      outcome: "done",
      summary: "已完成",
    });
    await assert.rejects(hub.updateRules({ invalid: true }), /规则无效/);
    assert.equal(
      JSON.parse(readFileSync(join(dataDir, "rules.json"), "utf8")).rules[0].name,
      "report",
    );
    await hub.updateRules({ ...config, rules: [] });
    assert.equal(
      (await call(hub, keys.source, "/v1/events", { id: "disabled", type: "report.requested" }))
        .routed.length,
      0,
    );
    // 外部原子替换走上游 watcher，验证 Windows basename 修复。
    writeFileSync(join(dataDir, "rules-next.json"), JSON.stringify(config));
    renameSync(join(dataDir, "rules-next.json"), join(dataDir, "rules.json"));
    let routed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      const ack = await call(hub, keys.source, "/v1/events", {
        id: `watch-${attempt}`,
        type: "report.requested",
        subject: "watch",
      });
      if (ack.routed.length) {
        routed = true;
        break;
      }
    }
    assert.equal(routed, true, "原子替换应触发真实规则重载");
  } finally {
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("上游官方协议一致性测试通过本机 HTTP", { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-conformance-"));
  const keys = credentials();
  const hub = await startAutoloopRuntime({
    ...runtimeOptions,
    dataDir,
    rules: rules(dataDir),
    credentials: keys,
  });
  try {
    const modulePath = pathToFileURL(
      resolve(import.meta.dirname, "../vendor/protocol/conformance.ts"),
    ).href;
    const upstream = (await import(modulePath)) as {
      conformance: (base: string, config: unknown) => Promise<{ passed: boolean; checks: number }>;
    };
    const result = await upstream.conformance(hub.baseUrl, {
      keys,
      eventType: "report.requested",
      answerer: "owner",
    });
    assert.equal(result.passed, true);
    assert.ok(result.checks > 100);
  } finally {
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test(
  "停止会话原子关闭待答与已答卡片、队列和定时器，迟到回执不能恢复事项",
  { timeout: 60_000 },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-cancel-session-"));
    const keys = credentials();
    const config = rules(dataDir);
    let hub = await startAutoloopRuntime({
      ...runtimeOptions,
      dataDir,
      rules: config,
      credentials: keys,
    });
    const begin = async (session: string) => {
      await call(hub, keys.source, "/v1/events", {
        id: session,
        type: "report.requested",
        subject: session,
      });
      const job = (await call(hub, keys.worker, `/v1/work?claim=${session}&wait=0&capacity=1`)).job;
      assert.ok(job);
      await call(hub, job.token, `/v1/runs/${job.run}/started`, { session });
      return job;
    };
    const later = [
      { key: "review", about: "复查", at: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    try {
      const first = await begin("cancel-a");
      await call(hub, first.token, `/v1/runs/${first.run}/result`, {
        outcome: "done",
        session: "cancel-a",
        summary: "待答",
        later,
        ask: [
          { key: "a1", title: "A1", text: "选项", options: ["继续", "结束"] },
          { key: "a2", title: "A2", text: "选项", options: ["继续", "结束"] },
        ],
      });
      const other = await begin("keep-b");
      await call(hub, other.token, `/v1/runs/${other.run}/result`, {
        outcome: "done",
        session: "keep-b",
        summary: "待答",
        later,
        ask: [{ key: "b1", title: "B1", text: "保留", options: ["继续", "结束"] }],
      });
      const before = await call(hub, keys.owner, "/v1/state");
      const a1 = before.cards.find((card: { title: string }) => card.title === "A1");
      await call(hub, keys.owner, `/v1/cards/${a1.id}/answer`, { choice: 0 });
      await hub.cancelSession("cancel-a");
      await hub.cancelSession("cancel-a");
      await assert.rejects(hub.cancelSession(""), /停止失败/);
      const after = await call(hub, keys.owner, "/v1/state");
      assert.deepEqual(
        after.cards.map((card: { title: string }) => card.title),
        ["B1"],
      );
      assert.equal(
        after.recentCards.filter(
          (card: { title: string; state: string }) =>
            /^A/.test(card.title) && card.state === "closed",
        ).length,
        2,
      );
      assert.equal(after.totals.queued, 0);
      assert.equal(
        (await call(hub, keys.owner, `/v1/cards/${a1.id}/answer`, { choice: 0 })).changed,
        false,
      );
      const late = await begin("cancel-c");
      await hub.cancelSession("cancel-c");
      const stoppedWork = await call(hub, keys.worker, "/v1/work?claim=stop&wait=0&capacity=0");
      assert.ok(stoppedWork.cancel.includes(late.run));
      const receipt = {
        outcome: "done",
        session: "cancel-c",
        summary: "迟到",
        later,
        ask: [{ key: "c1", title: "C1", text: "不应创建", options: ["继续", "结束"] }],
      };
      assert.equal(
        (await call(hub, late.token, `/v1/runs/${late.run}/result`, receipt)).rejected.length,
        2,
      );
      assert.equal(
        (await call(hub, late.token, `/v1/runs/${late.run}/result`, receipt)).duplicate,
        true,
      );
      await hub.stop();
      const probe = [
        'import { DatabaseSync } from "node:sqlite";',
        "const db = new DatabaseSync(process.argv[1], { readOnly: true });",
        "try { console.info(JSON.stringify({ timers: db.prepare(\"SELECT data FROM projections WHERE collection = 'timers'\").all(), facts: db.prepare(\"SELECT fact FROM facts WHERE json_extract(fact, '$.type') = 'cancelSession'\").all() })); } finally { db.close(); }",
      ].join("\n");
      const node =
        runtimeOptions.nodePath ??
        resolve(
          import.meta.dirname,
          "../.runtime",
          process.platform === "win32" ? "node.exe" : "node",
        );
      const stored = JSON.parse(
        execFileSync(
          node,
          [
            "--disable-warning=ExperimentalWarning",
            "--input-type=module",
            "-e",
            probe,
            join(dataDir, "hub.db"),
          ],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      const pendingTimers = stored.timers.map((row: { data: string }) => JSON.parse(row.data));
      assert.deepEqual(
        pendingTimers
          .filter((timer: { event_id: number | null }) => timer.event_id === null)
          .map((timer: { session: string }) => timer.session),
        ["keep-b"],
      );
      assert.equal(stored.facts.length, 2);
      const cancelled = JSON.parse(stored.facts[0].fact);
      const tables = new Set(cancelled.changes.map((change: { table: string }) => change.table));
      assert.ok(tables.has("cards") && tables.has("timers") && tables.has("runs"));
      hub = await startAutoloopRuntime({
        ...runtimeOptions,
        dataDir,
        rules: config,
        credentials: keys,
      });
      assert.equal(
        (await call(hub, keys.worker, "/v1/work?claim=restart&wait=0&capacity=1")).job,
        null,
      );
      assert.deepEqual(
        (await call(hub, keys.owner, "/v1/state")).cards.map(
          (card: { title: string }) => card.title,
        ),
        ["B1"],
      );
    } finally {
      await hub.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

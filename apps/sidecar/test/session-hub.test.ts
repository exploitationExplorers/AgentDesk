import { syncDeviceFiles } from "../src/services/session-hub/sync";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { hubKey, HubSnapshot } from "@agentdesk/shared";
import { openDatabase } from "../src/db/client";
import { SessionHub } from "../src/services/session-hub";
import { record } from "../src/services/session-hub/record";
import { codexSessions } from "../src/services/session-hub/sources";

describe("AgentDesk 会话中心", () => {
  it("直接读取 Codex 旧版表，兼容秒级时间和可选字段", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdesk-codex-fixture-"));
    const db = new Database(join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,git_branch TEXT,updated_at INTEGER)");
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?)").run(
      "demo",
      "PR #123 修复",
      dir,
      "feature/demo",
      1750000000,
    );
    db.close();
    expect(await codexSessions(dir)).toMatchObject([
      {
        id: "demo",
        tool: "codex",
        title: "PR #123 修复",
        directory: dir,
        branch: "feature/demo",
        prs: [123],
        updatedAt: 1750000000000,
      },
    ]);
  });
  it("刷新保留 PR 绑定，失败的来源保留上次快照，不把外机记录当成本机打开", async () => {
    const db = openDatabase(":memory:");
    let fail = false;
    const empty = async () => [];
    const sources = {
      codex: async () => {
        if (fail) throw new Error("busy");
        return [record("codex", "abc", { title: "local" })];
      },
      "claude-desktop": empty,
      "gemini-desktop": empty,
      antigravity: empty,
      grok: empty,
      cursor: empty,
      claude: empty,
      gemini: empty,
      agentdesk: empty,
    };
    try {
      const service = new SessionHub(db, sources);
      const { local } = await service.index();
      const key = hubKey(local.deviceId, local.sessions[0]!);
      await service.bind(key, 12);
      fail = true;
      const failed = await service.index(true);
      expect(failed.local.sessions[0]?.prs).toEqual([12]);
      expect(failed.warnings).toHaveLength(1);
      const other = HubSnapshot.parse({
        ...local,
        deviceId: crypto.randomUUID(),
        deviceName: "other",
      });
      service.import(other);
      const recreated = new SessionHub(db, sources);
      const result = await recreated.index();
      expect(result.local.deviceId).toBe(local.deviceId);
      expect(result.devices).toEqual([other]);
      await expect(
        recreated.localRow(hubKey(other.deviceId, other.sessions[0]!)),
      ).rejects.toThrow();
      const webKey = service.addWeb("issue", "https://example.com/15", 15);
      expect((await service.localRow(webKey)).prs).toEqual([15]);
      expect(service.addWeb("renamed", "https://example.com/15")).toBe(webKey);
    } finally {
      db.close();
    }
  });
});

it("设备目录交换完整快照，忽略损坏的外机文件，不回读本机文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentdesk-device-sync-"));
  const local = HubSnapshot.parse({
    format: "agentdesk-session-index-v1",
    deviceName: "desk",
    deviceId: crypto.randomUUID(),
    sessions: [record("codex", "local", { title: "local" })],
  });
  const other = { ...local, deviceId: crypto.randomUUID(), deviceName: "laptop" };
  await writeFile(join(dir, `${other.deviceId}.json`), JSON.stringify(other));
  await writeFile(join(dir, `${crypto.randomUUID()}.json`), "{");
  const peers: HubSnapshot[] = [];
  expect(await syncDeviceFiles(local, (snapshot) => peers.push(snapshot), dir)).toBe(1);
  expect(peers).toEqual([other]);
  expect(JSON.parse(await readFile(join(dir, `${local.deviceId}.json`), "utf8"))).toEqual(local);
});

it("searches Codex history for PR mentions, ranks links first and keeps message excerpts out of shared snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-history-"));
  const state = new Database(join(root, "state_5.sqlite"));
  state.exec("CREATE TABLE threads(id TEXT,title TEXT,updated_at INTEGER)");
  for (const [id, updated] of [
    ["bound", 1],
    ["mention", 2],
    ["only-id-12", 3],
  ])
    state.prepare("INSERT INTO threads VALUES(?,?,?)").run(id, "Fixture", updated);
  state.close();
  const history = new Database(join(root, "thread_history_1.sqlite"));
  history.exec(
    "CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER)",
  );
  const put = history.prepare("INSERT INTO thread_items VALUES(?,?,?,1)");
  put.run(
    "mention",
    "userMessage",
    JSON.stringify({ content: [{ type: "text", text: "message-only needle12 in a filename" }] }),
  );
  put.run("bound", "toolCall", JSON.stringify({ url: "https://github.com/example/demo/pull/12" }));
  history.close();
  const db = openDatabase(":memory:");
  try {
    const empty = async () => [];
    const service = new SessionHub(db, {
      codex: () => codexSessions(root),
      agentdesk: empty,
      cursor: empty,
      claude: empty,
      gemini: empty,
      "claude-desktop": empty,
      "gemini-desktop": empty,
      grok: empty,
      antigravity: empty,
    });
    const idx = await service.index();
    expect(JSON.stringify(idx.local)).not.toContain("message-only");
    expect(idx.local.sessions.find((r) => r.id === "bound")?.prLinks).toEqual([
      "https://github.com/example/demo/pull/12",
    ]);
    for (const query of ["12", "#12", "PR #12", "pull/12", "example/demo#12"]) {
      const result = await service.search(
        { query, device: idx.local.deviceId, tool: "codex" },
        false,
      );
      expect(result.hits.map((r) => r.reason)).toEqual(["直接绑定 PR #12", "会话提及 #12"]);
      expect(result.hits[1]?.snippet).toContain("needle12");
    }
    expect((await service.search({ query: "12", onlyPr: true }, false)).hits).toHaveLength(1);
    expect((await service.search({ query: "needle12 filename" }, false)).hits).toHaveLength(1);
    expect((await service.search({ query: "12", tool: "cursor" }, false)).hits).toHaveLength(0);
  } finally {
    db.close();
  }
});

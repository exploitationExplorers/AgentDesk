import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startAutoloopRuntime } from "../../autoloop-runtime/src/index";
import { AutoloopClient } from "../src/autoloop";

it("固定版本真实 Hub：空字段、幂等收据、卡片对账、续办、关闭与事实流", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentdesk-protocol-中文 空格-"));
  const credentials = {
    owner: randomBytes(32).toString("base64url"),
    worker: randomBytes(32).toString("base64url"),
    source: randomBytes(32).toString("base64url"),
  };
  const hub = await startAutoloopRuntime({
    dataDir,
    credentials,
    ...(process.env.AGENTDESK_AUTOLOOP_TEST_NODE
      ? { nodePath: process.env.AGENTDESK_AUTOLOOP_TEST_NODE }
      : {}),
    rules: {
      sources: { agentdesk: { name: "AgentDesk" } },
      agents: {
        agentdesk: { name: "AgentDesk", worker: "agentdesk", use: "agentdesk", access: "edit" },
      },
      rules: [
        {
          name: "report",
          when: { source: "agentdesk", types: ["report.requested"] },
          to: "agentdesk",
          cwd: dataDir,
          prompt: "生成报告",
        },
      ],
    },
  });
  const client = new AutoloopClient({ baseUrl: hub.baseUrl, credentials });
  try {
    await client.health();
    expect((await client.work("empty", 1)).job).toBeNull();
    const event = { id: "first", type: "report.requested" };
    const ack = await client.postEvent(event);
    expect(await client.postEvent(event)).toMatchObject({ event: ack.event, duplicate: true });
    const job = (await client.work("first", 1)).job!;
    expect(job.rule.cwd).toBe(dataDir);
    expect(job.session).toBeNull();
    expect(job.context.events).toHaveLength(1);
    await client.started(job.run, job.token, "conversation-one");
    const result = JSON.stringify({
      outcome: "done",
      session: "conversation-one",
      ask: [
        { key: "scope", title: "汇报范围", text: "请选择", options: ["项目", "风险"] },
        { key: "format", title: "输出格式", text: "请选择", options: ["PPT", "Word"] },
      ],
    });
    expect((await client.result(job.run, job.token, result)).rejected).toEqual([]);
    expect((await client.result(job.run, job.token, result)).duplicate).toBe(true);
    const facts = client.facts(0, AbortSignal.timeout(10_000));
    const cards = new Map<number, string>();
    for await (const fact of facts) {
      for (const change of fact.changes)
        if (change.table === "cards" && change.row?.kind === "ask")
          cards.set(Number(change.key), String(change.row.title));
      if (cards.size === 2) break;
    }
    const cardId = [...cards].find(([, title]) => title === "汇报范围")![0];
    const formatId = [...cards].find(([, title]) => title === "输出格式")![0];
    expect(await client.getCard(cardId)).toMatchObject({
      state: "open",
      choice: null,
      answer: null,
    });
    expect(
      await client.answerCard(cardId, JSON.stringify({ choice: 0, text: " 补充说明 " })),
    ).toMatchObject({ changed: true, state: "decided" });
    expect(await client.answerCard(cardId, JSON.stringify({ choice: 1 }))).toMatchObject({
      changed: false,
      state: "decided",
    });
    expect(await client.getCard(cardId)).toMatchObject({ choice: 0, answer: "补充说明" });
    expect(await client.resolveCard(cardId, "停止事项")).toEqual({ changed: false });
    expect(await client.resolveCard(formatId, "停止事项")).toEqual({ changed: true });
    expect(await client.resolveCard(formatId, "停止事项")).toEqual({ changed: false });
    const resumed = (await client.work("resume", 1)).job!;
    expect(resumed.session).toBe("conversation-one");
    expect(resumed.context.answers[0]).toMatchObject({ card: cardId, choice: 0, text: "补充说明" });
    await client.result(
      resumed.run,
      resumed.token,
      JSON.stringify({ outcome: "done", summary: "完成" }),
    );
    expect(await client.getCard(cardId)).toMatchObject({ state: "done", choice: 0 });
    expect(await client.getCard(formatId)).toMatchObject({ state: "closed", result: "停止事项" });
  } finally {
    await hub.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);

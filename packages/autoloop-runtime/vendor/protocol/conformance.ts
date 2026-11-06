// The protocol, checked over real HTTP against a hub set up for it. It writes events and cards, so never a hub in use.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkSchema } from "./schema.ts";

export type Probe = {
  keys: { source: string; worker: string; channel: string; owner: string };
  eventType: string;
  answerer: string;
};
export async function conformance(base: string, config: Probe, request: typeof fetch = fetch) {
  let checks = 0;
  const { keys } = config;
  const tag = randomUUID();
  const call = async (path: string, key: string, body?: unknown, status = 200, schema?: string) => {
    const response = await request(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    checks++;
    assert.equal(response.status, status, `${path} 状态码`);
    const value = await response.json();
    if (schema) assert.deepEqual(checkSchema(schema, value), [], `${path} 格式`);
    return value;
  };
  const doors: [string, unknown, string[]][] = [
    ["/v1/events", {}, ["source"]],
    ["/v1/tell", {}, ["source", "worker"]],
    ["/v1/work?claim=probe&wait=0", undefined, ["worker"]],
    ["/v1/cards/next?wait=0", undefined, ["channel"]],
    ["/v1/state", undefined, ["owner"]],
    ["/v1/stream", undefined, ["owner"]],
    ["/v1/runs/1/started", {}, []],
    ["/v1/runs/1/result", {}, []],
    ["/v1/runs/1/cancel", {}, ["owner"]],
    ["/v1/runs/1/why", undefined, ["owner"]],
    ["/v1/cards/1/answer", {}, ["owner", "channel"]],
    ["/v1/cards/1/resolve", {}, ["owner"]],
    ["/v1/cards/1/delivered", {}, ["channel"]],
    ["/v1/cards/1/failed", {}, ["channel"]],
  ];
  const everyKey = Object.entries({ ...keys, absent: "", madeup: "invalid" });
  for (const [path, body, allowed] of doors) {
    for (const [kind, key] of everyKey) {
      if (!allowed.includes(kind)) await call(path, key, body, 401, "error");
    }
  }
  assert.equal((await call("/healthz", "")).ok, true);
  await call("/v1/not-a-door", keys.owner, undefined, 404, "error");
  await call("/v1/in/missing", "", {}, 404, "error");
  await call("/v1/events", keys.source, { id: tag, type: config.eventType, source: "someone-else" }, 400);
  await call("/v1/events", keys.source, { type: config.eventType }, 400);
  await call("/v1/events", keys.source, { id: tag, type: "not a type" }, 400);
  for (const [body, status] of [
    ["{invalid", 400],
    [JSON.stringify({ id: tag, type: config.eventType, detail: "x".repeat(2 * 1024 * 1024) }), 413],
  ] as const) {
    const response = await request(base + "/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${keys.source}` },
      body,
    });
    checks++;
    assert.equal(response.status, status, "事件正文边界");
    assert.deepEqual(checkSchema("error", await response.json()), []);
  }
  await call("/v1/work?wait=0", keys.worker, undefined, 400);
  await call("/v1/state?before=-1", keys.owner, undefined, 400);
  await call("/v1/stream?after=-1", keys.owner, undefined, 400);
  const event = { id: tag, type: config.eventType, subject: `#${tag}` };
  const accepted = await call("/v1/events", keys.source, event, 200, "eventAck");
  assert.equal(accepted.duplicate, false);
  assert.ok(accepted.routed.length);
  const duplicate = await call("/v1/events", keys.source, event, 200, "eventAck");
  assert.equal(duplicate.event, accepted.event);
  assert.equal(duplicate.duplicate, true);
  const take = () => call(`/v1/work?claim=${tag}&wait=0`, keys.worker, undefined, 200, "work");
  const first = (await take()).job;
  const job = (await take()).job;
  assert.ok(job);
  assert.equal(job.run, first.run);
  await call(`/v1/runs/${job.run}/started`, first.token, {}, 401);
  await call(`/v1/runs/${job.run}/started`, job.token, { session: `session-${tag}` });
  await call("/v1/events", keys.source, { ...event, id: `other-${tag}`, subject: `other-${tag}` });
  const otherJob = (await call(`/v1/work?claim=other-${tag}&wait=0`, keys.worker, undefined, 200, "work")).job;
  assert.ok(otherJob, "检查规则的 parallel 至少要是 2");
  assert.notEqual(otherJob.run, job.run);
  await call(`/v1/runs/${otherJob.run}/result`, job.token, { outcome: "done" }, 401);
  await call(`/v1/runs/${job.run}/result`, otherJob.token, { outcome: "done" }, 401);
  await call(`/v1/runs/${otherJob.run}/result`, otherJob.token, { outcome: "done" });
  await call(`/v1/runs/${job.run}/result`, job.token, { outcome: "unknown" }, 400);
  const result = {
    outcome: "done",
    summary: "一致性检查",
    ask: [
      { title: `选择 ${tag}`, text: "选择一个", options: ["甲", "乙"], key: tag },
      { title: `另一个 ${tag}`, text: "核实后关闭", options: ["甲", "乙"], key: `other-${tag}` },
    ],
    resolve: [{ card: 99999999, reason: "越界" }],
  };
  const receipt = await call(`/v1/runs/${job.run}/result`, job.token, result, 200, "receiptAck");
  assert.equal(receipt.rejected.length, 1);
  const replay = await call(`/v1/runs/${job.run}/result`, job.token, result, 200, "receiptAck");
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.rejected, receipt.rejected);
  await call(`/v1/runs/${job.run}/result`, job.token, { outcome: "nothing" }, 409);
  const cards = [];
  for (;;) {
    const { card } = await call("/v1/cards/next?wait=0", keys.channel);
    if (!card) break;
    assert.deepEqual(checkSchema("card", card), []);
    cards.push(card);
    await call(`/v1/cards/${card.id}/delivered`, keys.channel, { version: card.version, ref: `probe-${card.id}` });
  }
  const [card, other] = cards.filter(({ kind, title }) => kind === "ask" && title.endsWith(tag));
  assert.ok(card && other);
  const answer = { choice: 0, by: config.answerer, ref: `probe-${card.id}` };
  await call(`/v1/cards/${card.id}/answer`, keys.channel, { ...answer, by: "not-allowed" }, 401);
  await call(`/v1/cards/${card.id}/answer`, keys.channel, { ...answer, ref: "wrong" }, 401);
  await call(`/v1/cards/${card.id}/answer`, keys.channel, { ...answer, choice: 99 }, 400);
  assert.equal((await call(`/v1/cards/${card.id}/answer`, keys.channel, answer)).changed, true);
  assert.equal((await call(`/v1/cards/${card.id}/answer`, keys.channel, { ...answer, choice: 1 })).changed, false);
  await call(`/v1/cards/${other.id}/resolve`, keys.owner, { reason: " " }, 400);
  assert.equal((await call(`/v1/cards/${other.id}/resolve`, keys.owner, { reason: "已核实" })).changed, true);
  assert.equal((await call(`/v1/cards/${other.id}/answer`, keys.owner, { choice: 0 })).changed, false);
  await call(`/v1/cards/${card.id}/failed`, keys.channel, { version: 1, error: "旧消息发送失败" });
  const next = (await take()).job;
  assert.equal(next.context.answers[0].choice, 0);
  await call(`/v1/runs/${next.run}/cancel`, keys.owner, {});
  assert.ok((await call("/v1/work?claim=cancel&capacity=0&wait=0", keys.worker)).cancel.includes(next.run));
  await call(`/v1/runs/${next.run}/result`, next.token, { outcome: "cancelled" });
  const told = await call("/v1/tell", keys.source, { key: tag, text: "检查完成" });
  assert.equal(told.duplicate, false);
  assert.equal((await call("/v1/tell", keys.source, { key: tag, text: "检查完成" })).duplicate, true);
  await call("/v1/tell", keys.worker, { key: tag, task: "not-assigned", text: "不能冒充" }, 401);
  const why = await call(`/v1/runs/${job.run}/why`, keys.owner);
  assert.ok(why.some((fact: { type: string }) => fact.type === "finish"));
  const abort = new AbortController();
  const stream = await request(base + "/v1/stream?after=0", {
    headers: { authorization: `Bearer ${keys.owner}` },
    signal: abort.signal,
  });
  try {
    checks++;
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let count = 0;
    while (!text.includes("\n\n")) {
      const { done, value } = await reader.read();
      assert.ok(!done, "日志流没有完整事实");
      text += decoder.decode(value, { stream: true });
    }
    for (const block of text.split("\n\n").slice(0, -1)) {
      const id = /^id: (\d+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      assert.ok(id && data, "日志流缺少事实");
      const fact = JSON.parse(data[1]);
      assert.deepEqual(checkSchema("fact", fact), []);
      assert.equal(fact.seq, Number(id[1]));
      const leaksKeys = fact.changes.some((change: { table: string }) => change.table === "keys");
      assert.ok(!leaksKeys, "日志流泄露密钥记录");
      count++;
    }
    assert.ok(count);
    for (const key of Object.values(keys)) assert.ok(!text.includes(key));
    await reader.cancel();
  } finally {
    abort.abort();
  }
  await call("/v1/state", keys.owner);
  return { checks, passed: true };
}

if (import.meta.main) {
  const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
  console.log(JSON.stringify(await conformance(process.argv[2], config), null, 2));
}

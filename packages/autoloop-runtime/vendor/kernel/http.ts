// The doors: every request the hub takes, which key it asks for, and which input it becomes. Nothing is decided here.
import { cardPage, PAGE_HEADERS, wordsPage } from "./card-page.ts";
import { whose, type Environment } from "./credentials.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import type { Row, View } from "./evolve.ts";
import { agentsOf, cancels, cardView, configuration } from "./query.ts";

export type Services = {
  now(): number;
  view(): View;
  environment: Environment;
  commit: string;
  dispatch(type: string, args: any[], now: number): any;
  state(now: number, before?: number): unknown;
  why(id: number): unknown;
  card(token: string): Row | undefined;
  wait(until: number, signal: AbortSignal): Promise<void>;
  stream(after: number, signal: AbortSignal, key: string): ReadableStream;
  adapt(source: string, headers: Headers, body: string): Promise<unknown[]>;
};

const MAX_BODY = 1024 * 1024;
const MAX_WAIT_SECONDS = 50;
const LINK_LIFETIME = 7 * 86400_000;
const CARD_LINK = /^\/c\/([A-Za-z0-9_-]{1,64})$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const KEY_HOLDERS: Record<string, string> = { owner: "本人", worker: "接单程序", channel: "通道", source: "来源" };
const NO_STORE = { "cache-control": "no-store" };

class TooLarge extends Error {}

async function readText(request: Request) {
  if (!request.body) return "";
  // A little over the limit is read to its end: hanging up mid-upload can cost the client its 413.
  if (Number(request.headers.get("content-length")) > 8 * MAX_BODY) throw new TooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size <= MAX_BODY) chunks.push(value);
    if (size > 8 * MAX_BODY) throw new TooLarge();
  }
  if (size > MAX_BODY) throw new TooLarge();
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: Request) {
  const text = await readText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("不是 JSON");
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });
function statusOf(error: unknown) {
  if (error instanceof TooLarge) return 413;
  if (error instanceof InputError) return 400;
  if (error instanceof AuthError) return 401;
  if (error instanceof Conflict) return 409;
  if (error instanceof NotFound) return 404;
  return 500;
}

function callFrom(services: Services, request: Request) {
  const url = new URL(request.url);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const now = services.now();
  const view = services.view();
  return { services, request, url, token, now, view, rules: configuration(view) };
}
type Call = ReturnType<typeof callFrom>;

const keyHolder = (call: Call, kind: string) => whose(call.view, kind, call.token);
const act = (call: Call, type: string, ...args: any[]) => call.services.dispatch(type, args, call.services.now());

function requireKey(call: Call, kind: string) {
  const holder = keyHolder(call, kind);
  if (!holder) throw new AuthError(`要${KEY_HOLDERS[kind]}自己的密钥`);
  return holder;
}

function ownerAct(call: Call, type: string, ...args: any[]) {
  requireKey(call, "owner");
  act(call, type, ...args);
  return json({ ok: true });
}

/** When a long poll gives up: as long as it asked to wait, up to the most anyone gets. */
function waitUntil(call: Call) {
  const seconds = Number(call.url.searchParams.get("wait") ?? MAX_WAIT_SECONDS) || 0;
  return call.now + Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
}

async function cardAtLink(call: Call, linkToken: string) {
  const { rules, request } = call;
  const { environment } = call.services;
  const card = call.services.card(linkToken);
  const linksInUse = Object.values(rules.channels).some((channel) => channel.links);
  if (!card || !linksInUse) throw new NotFound("没有这张卡片");
  if (call.now - Date.parse(card.created_at) > LINK_LIFETIME) {
    throw new AuthError("这个链接过期了。在装它的电脑上运行 agent-autoloop status，还没答的卡片都在那里，可以接着回答");
  }
  if (request.method === "GET") return new Response(cardPage(cardView(card, environment)), { headers: PAGE_HEADERS });
  const form = new URLSearchParams(await readText(request));
  const choice = form.has("choice") && { choice: Number(form.get("choice")) };
  act(call, "answer", card.id, { ...choice, text: form.get("text") ?? undefined, by: "链接" });
  return new Response(null, { status: 303, headers: { location: call.url.pathname, ...NO_STORE } });
}

async function webhook(call: Call, source: string) {
  if (!call.rules.sources[source]?.adapter) throw new NotFound("这个来源不收 Webhook");
  const events = await call.services.adapt(source, call.request.headers, await readText(call.request));
  return json({ events: events.map((event) => act(call, "ingest", source, event)) });
}

async function tell(call: Call) {
  const { rules, view } = call;
  const source = keyHolder(call, "source");
  const worker = source ? null : keyHolder(call, "worker");
  if (!source && !worker) throw new AuthError("要来源或接单程序的密钥");
  const input = await readJson(call.request);
  const expected = source ? ["key", "text"] : ["key", "task", "text"];
  const hasExpected = input && typeof input === "object" && Object.keys(input).sort().join() === expected.join();
  const keyIsValid = typeof input?.key === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.key);
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!hasExpected || !keyIsValid || !text || [...text].length > 20_000) {
    throw new InputError("要有正确的 key 和 text，接单程序还要写 task，text 最多 20000 字");
  }
  if (source) {
    return json(act(call, "tell", `source:${source}:${input.key}`, rules.sources[source]?.name ?? source, text));
  }
  const task = rules.elsewhere.find((task) => task.name === input.task && agentsOf(view, worker!).includes(task.to));
  if (!task) throw new AuthError("这台接单程序没有这个定时任务");
  return json(act(call, "tell", `elsewhere:${task.name}:${input.key}`, task.name, text));
}

async function work(call: Call) {
  const { services, request, url, token } = call;
  const worker = requireKey(call, "worker");
  const claim = url.searchParams.get("claim") ?? "";
  if (!claim || claim.length > 200) throw new InputError("claim 是这次领活的编号，最多 200 字");
  const running = (url.searchParams.get("running") ?? "").split(",").filter((id) => POSITIVE_ID.test(id));
  act(call, "heartbeat", worker, running.map(Number));
  const until = waitUntil(call);
  for (;;) {
    if (!whose(services.view(), "worker", token)) throw new AuthError("密钥已失效");
    const wantsWork = !request.signal.aborted && url.searchParams.get("capacity") !== "0";
    const job = wantsWork ? act(call, "claimNext", worker, claim) : null;
    const cancel = cancels(services.view(), worker);
    if (job || cancel.length || services.now() >= until || request.signal.aborted) return json({ job, cancel });
    await services.wait(until, request.signal);
  }
}

async function nextCard(call: Call) {
  const { services, request, token } = call;
  const channel = requireKey(call, "channel");
  const until = waitUntil(call);
  act(call, "channelSeen", channel);
  for (;;) {
    if (!whose(services.view(), "channel", token)) throw new AuthError("密钥已失效");
    const card = request.signal.aborted ? null : act(call, "nextCard", channel);
    if (card || services.now() >= until || request.signal.aborted) return json({ card });
    await services.wait(until, request.signal);
  }
}

async function cardAction(call: Call, id: number, action: string) {
  const channel = keyHolder(call, "channel");
  requireKey(call, action === "resolve" || (action === "answer" && !channel) ? "owner" : "channel");
  const given = await readJson(call.request);
  if (action === "resolve") {
    const reason = given?.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
      throw new InputError("写一句处理结果，最多 1000 字");
    }
    return json({ changed: act(call, "resolve", id, reason.trim(), "本人") });
  }
  if (action === "answer") {
    const who = channel ? { by: given?.by, ref: given?.ref, channel } : { by: "本人" };
    return json(act(call, "answer", id, { choice: given?.choice, text: given?.text, ...who }));
  }
  if (!Number.isInteger(given?.version)) throw new InputError("要说明是哪个版本");
  const ref = typeof given.ref === "string" ? given.ref : null;
  act(call, action, channel, id, given.version, action === "delivered" ? ref : String(given.error ?? ""));
  return json({ ok: true });
}

function state(call: Call) {
  requireKey(call, "owner");
  const before = call.url.searchParams.get("before");
  if (before !== null && !POSITIVE_ID.test(before)) throw new InputError("编号不正确");
  return json(call.services.state(call.now, before === null ? undefined : Number(before)));
}

function stream(call: Call) {
  const { request, services, token } = call;
  requireKey(call, "owner");
  const after = call.url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new InputError("日志序号不正确");
  const headers = { "content-type": "text/event-stream", ...NO_STORE, "x-accel-buffering": "no" };
  return new Response(services.stream(Number(after), request.signal, token), { headers });
}

async function route(call: Call): Promise<Response> {
  const { request, services, token } = call;
  const { method } = request;
  const path = call.url.pathname;
  if (method === "GET" && path === "/healthz") return json({ ok: true, commit: services.commit });
  // A key's name is whatever `key new` was given; it only has to stay one path segment when encoded.
  const key = /^\/v1\/keys\/(source|worker|channel|owner)\/([^/]+)$/.exec(path);
  if (method === "DELETE" && key) {
    requireKey(call, "owner");
    let name: string;
    try {
      name = decodeURIComponent(key[2]);
    } catch {
      throw new InputError("密钥名字不正确");
    }
    return json({ ok: true, changed: act(call, "removeKey", key[1], name) });
  }
  const link = CARD_LINK.exec(path);
  if (link && ["GET", "POST"].includes(method)) return cardAtLink(call, link[1]);
  const hook = /^\/v1\/in\/([a-z][a-z0-9-]*)$/.exec(path);
  if (method === "POST" && hook) return webhook(call, hook[1]);
  if (method === "POST" && path === "/v1/events") {
    return json(act(call, "ingest", requireKey(call, "source"), await readJson(request)));
  }
  if (method === "POST" && path === "/v1/tell") return tell(call);
  if (method === "GET" && path === "/v1/work") return work(call);
  const [, runPart, action] = /^\/v1\/runs\/([1-9][0-9]*)\/(started|result|cancel|why)$/.exec(path) ?? [];
  const runId = Number(runPart);
  if (method === "GET" && action === "why") {
    requireKey(call, "owner");
    return json(services.why(runId));
  }
  if (method === "POST" && action === "cancel") return ownerAct(call, "cancel", runId);
  if (method === "POST" && action === "started") {
    act(call, "started", runId, token, await readJson(request));
    return json({ ok: true });
  }
  if (method === "POST" && action === "result") return json(act(call, "finish", runId, token, await readJson(request)));
  if (method === "GET" && path === "/v1/cards/next") return nextCard(call);
  const card = /^\/v1\/cards\/([1-9][0-9]*)\/(delivered|failed|answer|resolve)$/.exec(path);
  if (method === "POST" && card) return cardAction(call, Number(card[1]), card[2]);
  if (method === "GET" && path === "/v1/state") return state(call);
  if (method === "GET" && path === "/v1/stream") return stream(call);
  return json({ error: "没有这个地址" }, 404);
}

export function createHandler(services: Services) {
  return async function handle(request: Request): Promise<Response> {
    const call = callFrom(services, request);
    try {
      return await route(call);
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) throw error;
      const message = error instanceof TooLarge ? "请求最多 1024 KB" : (error as Error).message;
      if (CARD_LINK.test(call.url.pathname)) return new Response(wordsPage(message), { status, headers: PAGE_HEADERS });
      return json({ error: message }, status);
    }
  };
}

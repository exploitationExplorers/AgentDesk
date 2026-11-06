// The protocol's own checks, with no state behind them: the hub applies them at its door, and a worker applies them to
// an Agent's receipt before handing it in, while the Agent can still be asked to write it again.
import { InputError } from "../kernel/errors.ts";

export const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** What the protocol allows a card answer to carry: the schema says so, and the hub keeps it. */
export const ANSWER_TEXT = 4000;
export const ANSWER_BY = 500;
export const ANSWER_REF = 500;
/** A channel's own reference to the message it sent. */
export const DELIVERY_REF = 500;
export type Later = { key: string; at?: string; about?: string; cancel?: boolean };
export type Ask = { title: string; text: string; options: string[]; recommend?: number; about?: string; key?: string };
export type Notice = { title: string; text: string; key?: string };
export type Usage = { input?: number; output?: number; cached?: number; cost?: number };

/** Missing figures stay missing: zero is a price or token count that was actually reported. */
export function addUsage(total: Usage | undefined, more: Usage | undefined): Usage | undefined {
  if (!more) return total;
  const result = { ...total };
  for (const field of Object.keys(more) as (keyof Usage)[])
    if (more[field] !== undefined) result[field] = (result[field] ?? 0) + more[field];
  return result;
}
export type Result = {
  outcome: "done" | "nothing" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  session?: string;
  usage?: Usage;
  ask?: Ask[];
  notice?: Notice[];
  resolve?: { card: number; reason: string }[];
  later?: Later[];
  events?: EventInput[];
};
export type Rejected = { card?: number; what?: string; reason: string };

export type EventInput = {
  id: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  link: string;
  hops: number;
};

const LIMITS = { id: 200, subject: 100, summary: 200, detail: 4000, link: 500 } as const;
const FIELDS = ["id", "type", "subject", "summary", "detail", "link", "hops"];

export function parseEvent(input: unknown): EventInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("事件要是一个 JSON 对象");
  }
  const given = input as Record<string, unknown>;
  for (const name of Object.keys(given)) if (!FIELDS.includes(name)) throw new InputError(`不认识的字段：${name}`);
  const field = (name: keyof typeof LIMITS | "type", required = false) => {
    const value = given[name] ?? "";
    if (typeof value !== "string") throw new InputError(`${name} 要是文字`);
    if (required && !value) throw new InputError(`缺少 ${name}`);
    if (name !== "type" && [...value].length > LIMITS[name]) throw new InputError(`${name} 最多 ${LIMITS[name]} 个字`);
    return value;
  };
  const hops = given.hops === undefined ? 0 : given.hops;
  if (!Number.isSafeInteger(hops) || (hops as number) < 0) throw new InputError("hops 要是非负整数");
  const event = {
    id: field("id", true),
    type: field("type", true),
    subject: field("subject"),
    summary: field("summary"),
    detail: field("detail"),
    link: field("link"),
    hops: hops as number,
  };
  if (!EVENT_TYPE.test(event.type)) throw new InputError("type 只能用小写字母、数字和 . _ -，以字母开头");
  // The subject and link go into the Agent's prompt, so neither may carry words: a subject is an identifier, a link a
  // web address in plain ASCII (anything else percent-encoded).
  if (!/^[A-Za-z0-9#._:\/@-]*$/.test(event.subject)) throw new InputError("subject 只能用字母、数字和 # . _ : / @ -");
  if (event.link && !/^https?:\/\/[\x21-\x7e]+$/.test(event.link)) {
    throw new InputError("link 要是网址，非 ASCII 的字要先编码");
  }
  return event;
}

type Item = Record<string, unknown>;

const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim() !== "" && [...value].length <= limit;
const optional = (value: unknown, limit: number) =>
  value === undefined || (typeof value === "string" && [...value].length <= limit);
const only = (item: object, names: string[]) => Object.keys(item).every((name) => names.includes(name));
const isItem = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
const items = (value: unknown, limit: number): value is Item[] =>
  value === undefined || (Array.isArray(value) && value.length <= limit && value.every(isItem));
/** A list of at most `limit` objects that each pass, or no list at all. */
const listOf = (value: unknown, limit: number, valid: (item: Item) => boolean) =>
  items(value, limit) && (value === undefined || value.every(valid));

export function dateTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysIn = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn[month - 1] && hour < 24 && minute < 60 && second < 60;
}

const validAsk = (ask: Item) =>
  only(ask, ["title", "text", "options", "recommend", "about", "key"]) &&
  text(ask.title, 200) &&
  text(ask.text, 4000) &&
  optional(ask.about, 4000) &&
  optional(ask.key, 100) &&
  Array.isArray(ask.options) &&
  ask.options.length >= 2 &&
  ask.options.length <= 5 &&
  ask.options.every((option) => text(option, 200)) &&
  (ask.recommend === undefined ||
    (Number.isInteger(ask.recommend) &&
      (ask.recommend as number) >= 0 &&
      (ask.recommend as number) < ask.options.length));

const validNotice = (notice: Item) =>
  only(notice, ["title", "text", "key"]) &&
  text(notice.title, 200) &&
  text(notice.text, 4000) &&
  optional(notice.key, 100);

const validResolve = (item: Item) =>
  only(item, ["card", "reason"]) &&
  Number.isSafeInteger(item.card) &&
  (item.card as number) > 0 &&
  text(item.reason, 1000);

const validLater = (later: Item) =>
  only(later, ["key", "at", "about", "cancel"]) &&
  text(later.key, 100) &&
  (later.cancel === true
    ? later.at === undefined
    : dateTime(later.at) && text(later.about, 4000) && later.cancel === undefined);

const validUsage = (usage: unknown) =>
  usage === undefined ||
  (isItem(usage) &&
    Object.values(usage as Item).every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0));

export function parseResult(input: unknown): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("结果要是一个 JSON 对象");
  }
  const result = { ...input } as Item;
  if (
    !only(result, ["outcome", "summary", "error", "session", "usage", "ask", "notice", "resolve", "later", "events"])
  ) {
    throw new InputError("结果里有不认识的字段");
  }
  if (!["done", "nothing", "failed", "cancelled"].includes(result.outcome as string)) {
    throw new InputError("outcome 只能是 done、nothing、failed、cancelled");
  }
  if (!optional(result.summary, 500) || !optional(result.error, 500) || !optional(result.session, 500)) {
    throw new InputError("summary、error、session 最多 500 字");
  }
  if (!validUsage(result.usage)) throw new InputError("usage 要是对象，里面要是有限的非负数字");
  if (!listOf(result.ask, 5, validAsk)) {
    throw new InputError("ask 每一项要有 title、text 和 2 到 5 个 options，recommend 是其中一个的序号，最多 5 项");
  }
  if (!listOf(result.notice, 10, validNotice)) throw new InputError("notice 每一项要有 title 和 text，最多 10 项");
  if (!listOf(result.resolve, 50, validResolve)) {
    throw new InputError("resolve 每一项要有卡片编号和 1000 字以内的核实依据，最多 50 项");
  }
  if (!listOf(result.later, 10, validLater)) {
    throw new InputError("later 每一项要有 key，以及带时区的 at 和 about，或者 cancel: true，最多 10 项");
  }
  if (result.events !== undefined) {
    if (!items(result.events, 100)) throw new InputError("events 最多 100 项");
    result.events = result.events.map(parseEvent);
  }
  return result as Result;
}

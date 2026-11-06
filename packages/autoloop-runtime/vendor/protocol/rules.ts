// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, the
// rules between them and, only to be shown, the scheduled tasks that run elsewhere. A mistake is caught here with a
// message saying where: at start it stops the hub, later it leaves the old rules running and the owner is told.
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`rules.json 有问题：\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"];
const NOT_EMPTY = "不能为空";
const ID_WORDS = "只能用小写字母、数字和 -";

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(`${where}要是一个对象`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where}缺少 ${name}`);
    } else if (!check(value[name])) issues.push(`${where}的 ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(`${where}有不认识的字段 ${name}`);
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(`规则名「${name}」重复了`);
  names.add(name);
  const where = `规则「${name}」`;
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY],
    ["when", isObject, "要是一个对象"],
    ["to", isKeyOf(rules.agents), `不是已登记的 Agent：${isObject(rule) ? rule.to : ""}`],
    ["cwd", (value) => typeof value === "string" && /^(~\/|\/(?!\/)|[A-Za-z]:[\\/])/.test(value) && !value.includes("\0"), "要是 POSIX 或 Windows 绝对目录"],
    ["skill", isText, NOT_EMPTY, true],
    ["prompt", isText, NOT_EMPTY, true],
    ["group", isText, NOT_EMPTY, true],
    ["parallel", isCount, "要是正整数", true],
    ["tell", (value) => TELLS.includes(value as string), `只能是 ${TELLS.join("、")}`, true],
    ["emits", isObject, "要是一个对象", true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, `${where}的 when `, when, [
      ["source", isKeyOf(rules.sources), `不是已登记的来源：${when.source}`],
      ["types", isTypes, "要是事件类型的列表，可以用 x.* 或 *"],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(`${where}的定时永远不会到来：${when.cron}`);
    }
    checkFields(issues, `${where}的 when `, when, [["cron", isCron, "不是有效的 cron"]]);
  }
  if (!isObject(rule)) return;
  // A plain command needs no words: a script that polls something is an agent too.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(`${where}的 skill 和 prompt 至少写一个`);
  }
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, `${where}的 emits `, rule.emits, [
      ["source", emittable, `不是已登记的来源：${rule.emits.source}`],
      ["types", isTypes, "要是事件类型的列表"],
    ]);
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`不是 JSON：${(error as Error).message}`]);
  }
  const issues: string[] = [];
  checkFields(issues, "rules.json ", parsed, [
    ["timezone", isZone, "不是有效的时区", true],
    ["askFirst", isWords, "要是文字的列表", true],
    ["sources", isObject, "要是一个对象"],
    ["agents", isObject, "要是一个对象"],
    ["channels", isObject, "要是一个对象", true],
    ["rules", Array.isArray, "要是一个列表"],
    ["elsewhere", Array.isArray, "要是一个列表", true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= ASK_FIRST;
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (SCHEDULE in rules.sources) issues.push(`来源 ${SCHEDULE} 是保留的，定时用规则的 cron`);
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(`来源的编号${ID_WORDS}：${id}`);
    checkFields(issues, `来源 ${id} `, source, [
      ["name", isText, NOT_EMPTY],
      ["adapter", isText, NOT_EMPTY, true],
    ]);
  }
  rules.sources[SCHEDULE] = { name: "定时" };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(`通道的编号${ID_WORDS}：${id}`);
    checkFields(issues, `通道 ${id} `, channel, [
      ["name", isText, NOT_EMPTY],
      ["answerers", isWords, "要是文字的列表", true],
      ["links", (value) => typeof value === "boolean", "要是 true 或 false", true],
    ]);
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(`Agent 的编号${ID_WORDS}：${id}`);
    checkFields(issues, `Agent ${id} `, agent, [
      ["name", isText, NOT_EMPTY],
      ["worker", isId, ID_WORDS],
      ["use", isId, ID_WORDS],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["access", (value) => ACCESS.includes(value as string), `只能是 ${ACCESS.join("、")}`, true],
      ["command", isSomeWords, "要是命令行的列表", !isObject(agent) || agent.use !== "command"],
      ["timeout", isCount, "要是正整数（分钟）", true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  for (const { group, parallel } of rules.rules) {
    if (limits.has(group) && limits.get(group) !== parallel) issues.push(`组「${group}」里的规则 parallel 要一致`);
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(`定时任务「${name}」和别的规则或定时任务重名`);
    names.add(name);
    checkFields(issues, `定时任务「${name}」`, task, [
      ["name", isText, NOT_EMPTY],
      ["source", isKeyOf(rules.sources), "不是已登记的来源"],
      ["to", isKeyOf(rules.agents), "不是已登记的 Agent"],
      ["cron", isCron, "不是有效的 cron"],
      ["where", isText, NOT_EMPTY],
    ]);
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}

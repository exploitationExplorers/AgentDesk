// A view reads an indexed projection. A decision owns only its overlay; evolve alone persists changes.
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
export type Row = Record<string, any>;
export const TABLES = [
  "events",
  "runs",
  "run_events",
  "cards",
  "deliveries",
  "timers",
  "schedules",
  "seen",
  "keys",
  "config",
  "due",
] as const;
export type Table = (typeof TABLES)[number];
export type Change = { table: Table; key: string; row: Row | null };
export type Fact = { version: 1; seq: number; at: number; type: string; changes: Change[]; meta?: Row };
export type Match = Record<string, SQLInputValue | SQLInputValue[] | { not: null }>;
const NUMBERED = new Set<Table>(["events", "runs", "cards", "timers"]);
const indexes: Partial<Record<Table, string[][]>> = {
  events: [["source", "key"], ["routed", "id"], ["id"]],
  runs: [["state", "id"], ["rule", "lane", "state", "id"], ["id"], ["finished_at"]],
  run_events: [["run_id"], ["event_id"]],
  cards: [
    ["key", "id"],
    ["state", "id"],
    ["rule", "lane", "state", "id"],
    ["rule", "lane", "answer_event", "id"],
    ["answer_event"],
    ["run_id"],
    ["id"],
    ["fyi", "created_at"],
  ],
  timers: [
    ["event_id", "id"],
    ["rule", "lane", "key", "id"],
    ["rule", "lane", "event_id", "id"],
  ],
  deliveries: [["channel"], ["card_id"]],
  due: [["at"]],
};
const field = (name: string) => `json_extract(data,'$.${name}')`;
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
export function statement(db: DatabaseSync, sql: string) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}
export function initialize(db: DatabaseSync) {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key));
    CREATE TABLE IF NOT EXISTS projection_meta(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL,next TEXT NOT NULL,format TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projection_refs(collection TEXT,key TEXT,seq INTEGER,PRIMARY KEY(collection,key,seq));
    CREATE TABLE IF NOT EXISTS projection_pending(key TEXT PRIMARY KEY,card_id INTEGER,channel TEXT);
    CREATE INDEX IF NOT EXISTS pending_channel ON projection_pending(channel,card_id);`);
  indexProjection(db);
  ready.add(db);
}
function indexProjection(db: DatabaseSync) {
  // Including collection prevents the planner preferring a collection-wide primary-key scan for IN predicates.
  db.exec(
    "CREATE INDEX IF NOT EXISTS projection_delivery_due ON projections(collection,json_extract(data,'$.given_up'),key) WHERE collection='deliveries' AND json_extract(data,'$.not_before') IS NOT NULL",
  );
  for (const [table, groups] of Object.entries(indexes))
    for (const [i, columns] of groups.entries()) {
      const order = NUMBERED.has(table as Table) ? field("id") : "key";
      const indexed = columns.map(field);
      if (!indexed.includes(order)) indexed.push(order);
      db.exec(
        `CREATE INDEX IF NOT EXISTS projection_${table}_${i} ON projections(collection,${indexed.join(",")}) WHERE collection='${table}'`,
      );
    }
}
const freeze = (row: Row): Row => {
  for (const child of Object.values(row))
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return Object.freeze(row);
};
export class View {
  readonly seq: number;
  readonly next: Record<string, number>;
  readonly db: DatabaseSync;
  readonly format: string;
  private base?: View;
  private changes = new Map<Table, Map<string, Row | null>>();
  // The biggest row there is, and every queued run asks for it. Facts bring a new view, so this can't go stale.
  private configs = new Map<string, Row | undefined>();
  constructor(db: DatabaseSync, seq = 0, next: Record<string, number> = {}, format = "") {
    this.db = db;
    this.seq = seq;
    this.next = { ...next };
    this.format = format;
  }
  get(table: Table, key: string | number): Row | undefined {
    const id = String(key),
      changes = this.changes.get(table);
    if (changes?.has(id)) return changes.get(id) ?? undefined;
    if (this.base) return this.base.get(table, id);
    if (table === "config" && this.configs.has(id)) return this.configs.get(id);
    const row = statement(this.db, "SELECT data FROM projections WHERE collection=? AND key=?").get(table, id);
    const found = row ? freeze(JSON.parse(String(row.data))) : undefined;
    if (table === "config") this.configs.set(id, found);
    return found;
  }

  select(table: Table, match: Match = {}, limit?: number, reverse = false): Row[] {
    const changed = this.changes.get(table);
    if (this.base && changed?.size) {
      const accepts = (row: Row) =>
        Object.entries(match).every(([key, value]) =>
          Array.isArray(value)
            ? value.includes(row[key] ?? null)
            : value && typeof value === "object" && "not" in value
              ? row[key] != null
              : (row[key] ?? null) === value,
        );
      const found = this.base
        .select(table, match, limit === undefined ? undefined : limit + changed.size, reverse)
        .filter((row) => !changed.has(keyOf(table, row)));
      for (const row of changed.values()) if (row && accepts(row)) found.push(row);
      if (NUMBERED.has(table)) found.sort((a, b) => (reverse ? b.id - a.id : a.id - b.id));
      else
        found.sort(
          (a, b) => (reverse ? -1 : 1) * Buffer.compare(Buffer.from(keyOf(table, a)), Buffer.from(keyOf(table, b))),
        );
      return limit === undefined ? found : found.slice(0, limit);
    }
    if (this.base) return this.base.select(table, match, limit, reverse);
    const params: SQLInputValue[] = [];
    const conditions = Object.entries(match).map(([key, value]) => {
      if (Array.isArray(value)) {
        params.push(JSON.stringify(value));
        return `${field(key)} IN (SELECT value FROM json_each(?))`;
      }
      if (value && typeof value === "object" && "not" in value) return `${field(key)} IS NOT NULL`;
      params.push(value);
      return `${field(key)} IS ?`;
    });
    // With IN filters, sorting the matching rows avoids the planner scanning every historic ID in order.
    const order = NUMBERED.has(table) ? `${Object.values(match).some(Array.isArray) ? "+" : ""}${field("id")}` : "key";
    const sql = `SELECT key,data FROM projections WHERE collection='${table}'${conditions.map((c) => ` AND ${c}`).join("")} ORDER BY ${order} ${reverse ? "DESC" : "ASC"}${limit === undefined ? "" : " LIMIT ?"}`;
    if (limit !== undefined) params.push(limit);
    return statement(this.db, sql)
      .all(...params)
      .map((item) => freeze(JSON.parse(String(item.data))));
  }

  *deliveryCandidates(channel: string, now: number): Generator<Row> {
    const sql = `SELECT c.data FROM (
      SELECT ${field("id")} AS id FROM projections WHERE collection='cards' AND ${field("state")}='open'
      UNION SELECT ${field("id")} FROM projections WHERE collection='cards' AND ${field("fyi")}=1 AND ${field("created_at")}>=?
      UNION SELECT card_id FROM projection_pending WHERE channel=?
    ) candidates JOIN projections c ON c.collection='cards' AND c.key=CAST(candidates.id AS TEXT) ORDER BY candidates.id`;
    for (const row of statement(this.db, sql).iterate(iso(now - 86400_000), channel))
      yield freeze(JSON.parse(String(row.data)));
  }
  fork() {
    const result = new View(this.db, this.seq, this.next, this.format);
    result.base = this;
    return result;
  }
  set(table: Table, key: string, row: Row | null) {
    let changed = this.changes.get(table);
    if (!changed) this.changes.set(table, (changed = new Map()));
    changed.set(key, row ? freeze(row) : null);
    if (typeof row?.id === "number") this.next[table] = Math.max(this.next[table] ?? 0, row.id);
  }
  close() {
    this.db.close();
  }
}
export function keyOf(table: Table, row: Row): string {
  if (NUMBERED.has(table)) return String(row.id);
  if (table === "run_events") return `${row.run_id}:${row.event_id}`;
  if (table === "deliveries") return `${row.card_id}:${row.channel}`;
  if (table === "schedules") return row.rule;
  if (table === "seen" || table === "keys") return `${row.kind}:${row.name}`;
  if (table === "due") return `${row.kind}:${row.key}`;
  return "rules";
}
export function empty(db = new DatabaseSync(":memory:")) {
  initialize(db);
  return new View(db);
}
export function evolve(view: View, facts: Iterable<Fact>, db = view.db, reset = false): View {
  initialize(db);
  if (reset) {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='projections' AND sql IS NOT NULL")
      .all())
      db.exec(`DROP INDEX "${String(name).replaceAll('"', '""')}"`);
    db.exec("DELETE FROM projections");
    db.exec("DELETE FROM projection_refs; DELETE FROM projection_pending");
    indexProjection(db);
  }
  let seq = view.seq;
  const next = { ...view.next };
  const put = statement(
    db,
    "INSERT INTO projections VALUES (?,?,?) ON CONFLICT(collection,key) DO UPDATE SET data=excluded.data",
  );
  const remove = statement(db, "DELETE FROM projections WHERE collection=? AND key=?");
  for (const fact of facts) {
    seq = fact.seq;
    const pending = new Map<string, Change>();
    for (const change of fact.changes) {
      pending.set(`${change.table}:${change.key}`, change);
      if (typeof change.row?.id === "number") next[change.table] = Math.max(next[change.table] ?? 0, change.row.id);
    }
    for (const { table, key, row } of pending.values()) {
      if (["events", "runs", "cards"].includes(table))
        statement(db, "INSERT OR IGNORE INTO projection_refs VALUES (?,?,?)").run(table, key, fact.seq);
      if (row === null) remove.run(table, key);
      else {
        const data = JSON.stringify(row);
        put.run(table, key, data);
        // A held run keeps the configuration it claimed, including through projection rebuilds.
        if (table === "config" && key === "rules") put.run(table, String(row.version), data);
      }
    }
    const current = new View(db);
    const deliveries = new Set<string>();
    for (const { table, key, row } of pending.values()) {
      if (table === "cards")
        for (const delivery of rows(current, "deliveries", { card_id: Number(key) }))
          deliveries.add(keyOf("deliveries", delivery));
      if (table === "deliveries") deliveries.add(key);
    }
    for (const key of deliveries) {
      statement(db, "DELETE FROM projection_pending WHERE key=?").run(key);
      const delivery = current.get("deliveries", key);
      const card = delivery && current.get("cards", delivery.card_id);
      if (card && delivery!.ref !== null && !delivery!.given_up && delivery!.version < card.version)
        statement(db, "INSERT INTO projection_pending VALUES (?,?,?)").run(key, card.id, delivery!.channel);
    }
  }
  statement(
    db,
    "INSERT INTO projection_meta VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,next=excluded.next,format=excluded.format",
  ).run(seq, JSON.stringify(next), view.format);
  return new View(db, seq, next, view.format);
}
const ready = new WeakSet<DatabaseSync>();

export function snapshot(view: View) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, {}])) as Record<Table, Record<string, Row>>;
  for (const item of statement(view.db, "SELECT collection,key,data FROM projections").all()) {
    tables[item.collection as Table][String(item.key)] = JSON.parse(String(item.data));
  }
  return { seq: view.seq, tables, next: { ...view.next } };
}
export const rows = (view: View, table: Table, match: Match = {}, limit?: number, reverse = false) =>
  view.select(table, match, limit, reverse);
export const iso = (ms: number) => new Date(ms).toISOString();

// The log and its expendable projection commit together. Only this module appends facts.
import type { DatabaseSync } from "node:sqlite";
import { Conflict } from "./errors.ts";
import { evolve, initialize, statement, View, type Fact } from "./evolve.ts";

export function readLog(db: DatabaseSync, after = 0): Fact[] {
  return [...iterateLog(db, after)];
}
export function* iterateLog(db: DatabaseSync, after = 0): Generator<Fact> {
  for (const row of db.prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq").iterate(after))
    yield JSON.parse(String(row.fact));
}
function transaction(db: DatabaseSync, work: () => View): View {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const view = work();
    db.exec("COMMIT");
    return view;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export const rebuild = (db: DatabaseSync, format = "") => {
  initialize(db);
  return transaction(db, () => evolve(new View(db, 0, {}, format), iterateLog(db), db, true));
};
export function openView(db: DatabaseSync, format: string) {
  initialize(db);
  const saved = statement(db, "SELECT seq,next,format FROM projection_meta WHERE id=1").get();
  if (!saved || saved.format !== format) return rebuild(db, format);
  return new View(db, Number(saved.seq), JSON.parse(String(saved.next)), format);
}
export function commit(db: DatabaseSync, view: View, produce: () => Fact[]): View {
  return transaction(db, () => {
    const latest = Number(statement(db, "SELECT COALESCE(MAX(seq),0) AS seq FROM facts").get()!.seq);
    if (latest !== view.seq) throw new Conflict("日志已变化，请重读后再提交");
    const facts = produce();
    if (!facts.length) return view;
    const insert = statement(db, "INSERT INTO facts(seq,fact) VALUES (?,?)");
    for (const fact of facts) insert.run(fact.seq, JSON.stringify(fact));
    return evolve(view, facts, db);
  });
}
/** Reads the view holding the write lock: commands write to this database too, so one read before it can be stale. */
export function commitLatest(db: DatabaseSync, format: string, produce: (view: View) => Fact[]): View {
  return transaction(db, () => {
    const view = openView(db, format);
    return commit(db, view, () => produce(view));
  });
}

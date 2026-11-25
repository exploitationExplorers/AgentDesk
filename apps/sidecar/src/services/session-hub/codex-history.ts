import { existsSync, createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { HubRecord } from "@agentdesk/shared";
import { withDatabase } from "./record";

function clean(s: string) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join("\n");
  if (value && typeof value === "object" && "text" in value) return content(value.text);
  return "";
}
function collectLinks(raw: string, links: Map<number, string>) {
  for (const m of raw.matchAll(
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,8})\b/g,
  )) {
    links.set(Number(m[2]), `https://github.com/${m[1]}/pull/${m[2]}`);
  }
}
export type IndexedSession = HubRecord & { searchText?: string };
// History rows often contain large tool outputs. Re-read only changed threads on periodic refresh.
const historyCache = new Map<string, { revision: string; row: IndexedSession }>();
export async function enrichCodexHistory(
  root: string,
  threads: { row: HubRecord; rollout: string }[],
): Promise<IndexedSession[]> {
  const file = join(root, "thread_history_1.sqlite");
  const enriched = new Map<string, IndexedSession>();
  function populate(row: HubRecord, users: string[], agents: string[], links: Map<number, string>) {
    const summary = row.summary || agents.at(-1)?.slice(0, 360) || "";
    collectLinks([row.title, row.prompt, summary].join("\n"), links);
    const prs = [...new Set([...links.keys(), ...row.prs])].sort((a, b) => b - a).slice(0, 64);
    const searchText = [
      clean(row.title),
      clean(row.prompt).slice(0, 360),
      clean(summary).slice(0, 360),
      ...new Set([...users, ...agents]),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 12000);
    enriched.set(row.id, {
      ...row,
      summary,
      prs,
      prLinks: prs.flatMap((n) => (links.has(n) ? [links.get(n)!] : [])),
      searchText,
    });
  }
  if (existsSync(file))
    withDatabase(file, (db) => {
      const columns = db.pragma("table_info(thread_items)") as { name: string }[];
      if (
        !["item_json", "item_type", "thread_id", "rollout_ordinal"].every((name) =>
          columns.some((c) => c.name === name),
        )
      )
        return;
      const query = db.prepare(
        `SELECT item_type,item_json FROM thread_items WHERE thread_id=? AND (item_type IN ('userMessage','agentMessage') OR instr(item_json,'/pull/')>0) ORDER BY rollout_ordinal`,
      );
      const revisionColumn = columns.some((c) => c.name === "updated_at_ordinal")
        ? "updated_at_ordinal"
        : "rollout_ordinal";
      const revisions = new Map(
        (
          db
            .prepare(
              `SELECT thread_id, count(*) AS n, max(${revisionColumn}) AS revision FROM thread_items GROUP BY thread_id`,
            )
            .all() as { thread_id: string; n: number; revision: number }[]
        ).map((r) => [r.thread_id, `${r.n}:${r.revision}`]),
      );
      for (const { row } of threads) {
        const key = join(root, row.id),
          revision = JSON.stringify([revisions.get(row.id), row]);
        const cached = historyCache.get(key);
        if (cached?.revision === revision) {
          enriched.set(row.id, cached.row);
          continue;
        }
        const first: string[] = [],
          last: string[] = [],
          agents: string[] = [];
        const links = new Map<number, string>();
        for (const item of query.iterate(row.id) as Iterable<{
          item_type: string;
          item_json: string;
        }>) {
          collectLinks(item.item_json, links);
          if (item.item_type !== "userMessage" && item.item_type !== "agentMessage") continue;
          let value;
          try {
            value = JSON.parse(item.item_json);
          } catch {
            continue;
          }
          const msg = clean(
            content(item.item_type === "userMessage" ? value?.content : value?.text),
          ).slice(0, 12000);
          if (!msg) continue;
          if (item.item_type === "userMessage") {
            if (first.length < 5) first.push(msg);
            last.push(msg);
            if (last.length > 5) last.shift();
          } else {
            agents.push(msg);
            if (agents.length > 4) agents.shift();
          }
        }
        if (first.length || agents.length || links.size) {
          populate(row, [...first, ...last], agents, links);
          historyCache.set(key, { revision, row: enriched.get(row.id)! });
        }
      }
    });
  const realRoot = await realpath(root);
  for (const { row, rollout } of threads) {
    if (enriched.has(row.id)) continue;
    const links = new Map<number, string>();
    // Older Codex versions may only have rollout files. Keep reads inside CODEX_HOME.
    const path = rollout && (await realpath(rollout).catch(() => null));
    if (
      path &&
      !relative(realRoot, path).startsWith("..") &&
      !isAbsolute(relative(realRoot, path)) &&
      path.endsWith(".jsonl")
    ) {
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) collectLinks(line, links);
    }
    populate(row, [], [], links);
  }
  return threads.map(({ row }) => enriched.get(row.id)!);
}

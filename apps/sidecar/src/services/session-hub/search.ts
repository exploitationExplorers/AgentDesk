import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  hubKey,
  parseHubPr,
  type HubIndex,
  type HubResolvedPr,
  type HubSearchResult,
} from "@agentdesk/shared";

export interface HubFilter {
  query: string;
  tool?: string;
  device?: string;
  onlyPr?: boolean;
  limit?: number;
}
export function searchSessions(
  index: HubIndex,
  corpus: ReadonlyMap<string, string>,
  filter: HubFilter,
  resolved: HubResolvedPr | null = null,
): HubSearchResult {
  const start = performance.now();
  const pr = parseHubPr(filter.query);
  const terms = filter.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^#(?=\d+$)/, ""));
  const hits = [];
  for (const device of [index.local, ...index.devices]) {
    if (filter.device && device.deviceId !== filter.device) continue;
    for (const row of device.sessions) {
      if ((filter.tool && row.tool !== filter.tool) || (filter.onlyPr && !row.prs.length)) continue;
      const key = hubKey(device.deviceId, row);
      const body =
        corpus.get(key) ?? [row.title, row.prompt, row.summary].filter(Boolean).join("\n");
      const lower = body.toLowerCase(),
        title = row.title.toLowerCase(),
        branch = row.branch.toLowerCase();
      const prText = [...row.prs.map(String), ...(row.prLinks || [])].join(" ").toLowerCase();
      let score = 0,
        reason = "",
        needles = terms;
      if (pr && row.prs.includes(pr.number)) {
        score = 1000;
        reason = `直接绑定 PR #${pr.number}`;
        needles = [];
      } else if (pr && [lower, title, branch].some((field) => field.includes(String(pr.number)))) {
        score = 650;
        reason = `会话提及 #${pr.number}`;
        needles = [String(pr.number)];
      } else if (
        resolved?.branch &&
        !["main", "master", "dev"].includes(resolved.branch) &&
        branch.includes(resolved.branch.toLowerCase())
      ) {
        score = 850;
        reason = `匹配 PR 分支 ${resolved.branch}`;
        needles = [];
      } else {
        const stems = resolved?.files
          .map((f) => basename(f, extname(f)).toLowerCase())
          .filter(
            (f) =>
              f.length >= 7 &&
              !["helpers", "constants", "package", "page.client"].includes(f) &&
              lower.includes(f),
          );
        const fields = [
          lower,
          title,
          branch,
          prText,
          row.directory.toLowerCase(),
          row.url?.toLowerCase() || "",
        ];
        if (stems?.length) {
          score = 430;
          reason = `匹配 PR 文件 ${stems[0]}`;
          needles = stems;
        } else if (terms.every((t) => fields.some((f) => f.includes(t)))) {
          const reasons = new Set<string>();
          for (const term of terms) {
            if (prText.includes(term)) {
              score += 120;
              reasons.add("PR");
            }
            if (branch.includes(term)) {
              score += 90;
              reasons.add("分支");
            }
            if (title.includes(term)) {
              score += 70;
              reasons.add("标题");
            }
            if (`${row.prompt} ${row.summary}`.toLowerCase().includes(term)) score += 35;
          }
          reason = reasons.size ? `匹配${[...reasons].join(" / ")}` : "正文关键词命中";
          // Generic keyword results are a fallback if a PR search found no PR signals.
          if (pr) score = -1;
        } else continue;
      }
      let snippet = "";
      for (const needle of needles) {
        const pos = lower.indexOf(needle);
        if (pos < 0) continue;
        const begin = Math.max(0, pos - 90),
          end = pos + needle.length + 90;
        snippet =
          (begin ? "…" : "") +
          body.slice(begin, end).replace(/\s+/g, " ").trim() +
          (end < body.length ? "…" : "");
        break;
      }
      hits.push({ key, reason, snippet, score, time: row.updatedAt });
    }
  }
  const hasPrSignals = pr && hits.some((h) => h.score >= 0);
  const ranked = hits.filter((h) => !hasPrSignals || h.score >= 0);
  return {
    hasMore: ranked.length > (filter.limit ?? 80),
    hits: ranked
      .sort((a, b) => b.score - a.score || b.time - a.time || a.key.localeCompare(b.key))
      .slice(0, filter.limit ?? 80)
      .map(({ key, reason, snippet }) => ({ key, reason, snippet })),
    elapsedMs: Math.round(performance.now() - start),
    resolved,
  };
}
const exec = promisify(execFile);
function localRepos(index: HubIndex, tool?: string) {
  const counts = new Map<string, number>();
  for (const row of index.local.sessions)
    if (row.directory && (!tool || row.tool === tool))
      counts.set(row.directory, (counts.get(row.directory) || 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => dir)
    .filter((dir) => existsSync(join(dir, ".git")))
    .slice(0, 20);
}
export async function resolveLocalPr(
  index: HubIndex,
  number: number,
  tool?: string,
): Promise<HubResolvedPr | null> {
  const deadline = Date.now() + 2000;
  for (const cwd of localRepos(index, tool)) {
    const remaining = deadline - Date.now();
    if (remaining < 50) break;
    try {
      const { stdout } = await exec(
        "git",
        [
          "--no-pager",
          "log",
          "--all",
          "-1",
          "--fixed-strings",
          `--grep=(#${number})`,
          "--format=%H%x1f%s",
        ],
        { cwd, timeout: Math.min(1200, remaining) },
      );
      const [sha, subject] = stdout.trim().split("\x1f");
      if (!sha || !subject || !/^[a-f0-9]{40,64}$/.test(sha)) continue;
      const files = await exec("git", ["--no-pager", "show", "--name-only", "--format=", sha], {
        cwd,
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 512 * 1024,
      })
        .then((r) => r.stdout.trim().split("\n").filter(Boolean).slice(0, 12))
        .catch(() => []);
      return { number, title: subject, branch: "", url: "", files };
    } catch {
      continue;
    }
  }
  return null;
}
export async function resolveGithubPr(
  index: HubIndex,
  pr: NonNullable<ReturnType<typeof parseHubPr>>,
  tool?: string,
): Promise<HubResolvedPr | null> {
  const cwd = localRepos(index, tool)[0];
  if (!cwd && !pr.repo) return null;
  const args = ["pr", "view", String(pr.number), "--json", "number,title,headRefName,url,files"];
  if (pr.repo) args.push("--repo", `github.com/${pr.repo}`);
  const { stdout } = await exec("gh", args, {
    cwd,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  const data = JSON.parse(stdout);
  if (
    data.number !== pr.number ||
    typeof data.url !== "string" ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(data.url)
  )
    return null;
  return {
    number: pr.number,
    title: data.title,
    branch: data.headRefName,
    url: data.url,
    files: (data.files ?? []).slice(0, 15).map((f: { path: string }) => f.path),
  };
}

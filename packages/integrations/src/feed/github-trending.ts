import { parse } from "node-html-parser";
import { FEED_USER_AGENT, type RawFeedItem } from "./types";

const toNumber = (text: string | undefined): number | null => {
  if (!text) return null;
  const n = Number.parseInt(text.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** GitHub 没有官方 Trending API，这里解析 github.com/trending 页面。 */
export function parseGithubTrending(html: string): RawFeedItem[] {
  const root = parse(html);
  return root
    .querySelectorAll("article.Box-row")
    .map((row): RawFeedItem | null => {
      const href = row.querySelector("h2 a")?.getAttribute("href")?.trim();
      if (!href) return null;
      const slug = href.replace(/^\//, "");
      const starsToday = row
        .querySelectorAll("span")
        .find((s) => /stars? (today|this week|this month)/.test(s.text))?.text;
      return {
        key: slug.toLowerCase(),
        source: "github",
        title: slug,
        url: `https://github.com/${slug}`,
        description: row.querySelector("p")?.text.trim() ?? "",
        language: row.querySelector('[itemprop="programmingLanguage"]')?.text.trim() ?? null,
        stars: toNumber(row.querySelector('a[href$="/stargazers"]')?.text),
        starsToday: toNumber(starsToday),
      };
    })
    .filter((x): x is RawFeedItem => x !== null);
}

export async function fetchGithubTrending(
  language = "",
  since: "daily" | "weekly" | "monthly" = "daily",
  signal?: AbortSignal,
): Promise<RawFeedItem[]> {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=${since}`;
  const response = await fetch(url, {
    headers: { "User-Agent": FEED_USER_AGENT, Accept: "text/html" },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub Trending ${response.status}`);
  return parseGithubTrending(await response.text());
}

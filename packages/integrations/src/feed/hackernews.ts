import type { RawFeedItem } from "./types";

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
  type?: string;
}

const API = "https://hacker-news.firebaseio.com/v0";

export async function fetchHackerNewsTop(limit = 20, signal?: AbortSignal): Promise<RawFeedItem[]> {
  const idsResponse = await fetch(`${API}/topstories.json`, { signal });
  if (!idsResponse.ok) throw new Error(`Hacker News ${idsResponse.status}`);
  const ids = ((await idsResponse.json()) as number[]).slice(0, limit);
  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const r = await fetch(`${API}/item/${id}.json`, { signal });
        return (await r.json()) as HnItem;
      } catch {
        return null;
      }
    }),
  );
  return items
    .filter((i): i is HnItem => !!i && i.type === "story" && !!i.title)
    .map((i) => ({
      key: String(i.id),
      source: "hackernews",
      title: i.title!,
      url: i.url ?? `https://news.ycombinator.com/item?id=${i.id}`,
      description: `${i.score ?? 0} points · ${i.descendants ?? 0} comments`,
      language: null,
      stars: i.score ?? null,
      starsToday: null,
    }));
}

import { FEED_USER_AGENT, type RawFeedItem } from "./types";

interface HfModel {
  id: string;
  likes?: number;
  downloads?: number;
  pipeline_tag?: string;
  tags?: string[];
  trendingScore?: number;
}

export async function fetchHuggingFaceTrending(
  limit = 20,
  signal?: AbortSignal,
): Promise<RawFeedItem[]> {
  const response = await fetch(
    `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${limit}`,
    { headers: { "User-Agent": FEED_USER_AGENT }, signal },
  );
  if (!response.ok) throw new Error(`Hugging Face ${response.status}`);
  const models = (await response.json()) as HfModel[];
  return models.map((m) => ({
    key: m.id.toLowerCase(),
    source: "huggingface",
    title: m.id,
    url: `https://huggingface.co/${m.id}`,
    description: [m.pipeline_tag, ...(m.tags ?? []).filter((t) => !t.includes(":")).slice(0, 6)]
      .filter(Boolean)
      .join(" · "),
    language: m.pipeline_tag ?? null,
    stars: m.likes ?? null,
    starsToday: m.trendingScore ?? null,
  }));
}

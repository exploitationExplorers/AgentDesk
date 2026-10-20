import { z } from "zod";

export const FeedSource = z.enum(["github", "huggingface", "hackernews"]);
export type FeedSource = z.infer<typeof FeedSource>;

export const FeedTag = z.enum(["ai", "frontend", "backend", "devops", "mobile", "other"]);
export type FeedTag = z.infer<typeof FeedTag>;

export const FeedItem = z.object({
  id: z.string(),
  source: FeedSource,
  title: z.string(),
  url: z.string(),
  description: z.string(),
  summaryZh: z.string().nullable(),
  tags: z.array(FeedTag),
  language: z.string().nullable(),
  stars: z.number().nullable(),
  starsToday: z.number().nullable(),
  date: z.string(),
  favorite: z.boolean(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const DailyDigest = z.object({
  date: z.string(),
  headline: z.string(),
  markdown: z.string(),
  itemCount: z.number(),
  createdAt: z.string(),
});
export type DailyDigest = z.infer<typeof DailyDigest>;

import type { FeedSource } from "@agentdesk/shared";

export interface RawFeedItem {
  /** 同一来源内稳定的 ID，用于去重 */
  key: string;
  source: FeedSource;
  title: string;
  url: string;
  description: string;
  language: string | null;
  stars: number | null;
  starsToday: number | null;
}

export const FEED_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 AgentDesk";

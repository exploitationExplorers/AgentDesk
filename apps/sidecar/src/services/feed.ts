import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { completeStructured, completeText, type ModelResolver } from "@agentdesk/agent-core";
import {
  classifyFeedItem,
  fetchGithubTrending,
  fetchHackerNewsTop,
  fetchHuggingFaceTrending,
  type RawFeedItem,
} from "@agentdesk/integrations";
import {
  AppError,
  ErrorCode,
  FeedTag,
  type DailyDigest,
  type FeedItem,
  type FeedSource,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { feedItems } from "../db/schema";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import { errorMessage, localDate, nowIso } from "../util";
import type { SettingsService } from "./settings";

type DigestDoc = DailyDigest & { id: string };

export interface FeedQuery {
  date?: string;
  source?: FeedSource;
  tag?: string;
  favorite?: boolean;
  q?: string;
  limit?: number;
}

const SummaryBatch = z.array(
  z.object({
    id: z.string(),
    summary: z.string(),
    tags: z
      .array(z.string())
      .transform((tags) => tags.filter((t): t is FeedTag => FeedTag.safeParse(t).success)),
  }),
);

export class FeedService {
  private readonly digests: Collection<DigestDoc>;
  private refreshing: Promise<unknown> | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly models: ModelResolver,
    private readonly hub: EventHub,
  ) {
    this.digests = new Collection<DigestDoc>(db, "digests");
  }

  private toItem(row: typeof feedItems.$inferSelect): FeedItem {
    return {
      id: row.id,
      source: row.source as FeedSource,
      title: row.title,
      url: row.url,
      description: row.description,
      summaryZh: row.summaryZh,
      tags: row.tags as FeedItem["tags"],
      language: row.language,
      stars: row.stars,
      starsToday: row.starsToday,
      date: row.date,
      favorite: row.favorite,
    };
  }

  list(query: FeedQuery = {}): FeedItem[] {
    const conditions = [];
    if (query.date) conditions.push(eq(feedItems.date, query.date));
    if (query.source) conditions.push(eq(feedItems.source, query.source));
    if (query.favorite) conditions.push(eq(feedItems.favorite, true));
    if (query.tag) conditions.push(like(feedItems.tags, `%"${query.tag}"%`));
    if (query.q) {
      const q = `%${query.q}%`;
      conditions.push(
        or(like(feedItems.title, q), like(feedItems.description, q), like(feedItems.summaryZh, q))!,
      );
    }
    return this.db
      .select()
      .from(feedItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(feedItems.date), feedItems.rank)
      .limit(query.limit ?? 200)
      .all()
      .map((r) => this.toItem(r));
  }

  dates(): string[] {
    return this.db
      .selectDistinct({ date: feedItems.date })
      .from(feedItems)
      .orderBy(desc(feedItems.date))
      .limit(60)
      .all()
      .map((r) => r.date);
  }

  toggleFavorite(id: string): FeedItem {
    this.db
      .update(feedItems)
      .set({ favorite: sql`NOT ${feedItems.favorite}` })
      .where(eq(feedItems.id, id))
      .run();
    const row = this.db.select().from(feedItems).where(eq(feedItems.id, id)).get();
    if (!row) throw new AppError(ErrorCode.NotFound, "条目不存在");
    return this.toItem(row);
  }

  /** 刷新今日热榜；并发调用会复用同一次刷新。 */
  refresh(): Promise<{ date: string; fetched: number; summarized: number; errors: string[] }> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing as Promise<{
      date: string;
      fetched: number;
      summarized: number;
      errors: string[];
    }>;
  }

  private async doRefresh() {
    const date = localDate();
    const errors: string[] = [];
    const languages = this.settings.get().feedLanguages;
    const tasks: Array<Promise<RawFeedItem[]>> = [
      ...languages.map((lang) => fetchGithubTrending(lang, "daily")),
      fetchHuggingFaceTrending(20),
      fetchHackerNewsTop(25),
    ];
    const settled = await Promise.allSettled(tasks);
    const seen = new Set<string>();
    const items: RawFeedItem[] = [];
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        errors.push(
          `${i < languages.length ? `GitHub(${languages[i] || "all"})` : i === languages.length ? "HuggingFace" : "HackerNews"}: ${errorMessage(r.reason)}`,
        );
        return;
      }
      for (const item of r.value) {
        const k = `${item.source}:${item.key}`;
        if (!seen.has(k)) {
          seen.add(k);
          items.push(item);
        }
      }
    });

    items.forEach((item, rank) => {
      const id = `${date}:${item.source}:${item.key}`;
      const tags = classifyFeedItem(item);
      this.db
        .insert(feedItems)
        .values({
          id,
          date,
          source: item.source,
          key: item.key,
          title: item.title,
          url: item.url,
          description: item.description,
          summaryZh: null,
          tags,
          language: item.language,
          stars: item.stars,
          starsToday: item.starsToday,
          rank,
          favorite: false,
        })
        .onConflictDoUpdate({
          target: feedItems.id,
          set: {
            stars: item.stars,
            starsToday: item.starsToday,
            description: item.description,
            rank,
          },
        })
        .run();
    });

    let summarized = 0;
    try {
      summarized = await this.summarize(date);
    } catch (error) {
      errors.push(`AI 摘要：${errorMessage(error)}`);
    }
    this.hub.publish(GLOBAL_CHANNEL, { type: "feed_updated", date } satisfies GlobalEvent);
    return { date, fetched: items.length, summarized, errors };
  }

  /** 用研究 Agent 的模型为缺少摘要的条目生成中文一句话摘要并校正标签。 */
  private async summarize(date: string): Promise<number> {
    const models = await this.models.resolve("research");
    if (models.length === 0) return 0;
    const pending = this.list({ date, limit: 500 }).filter((i) => !i.summaryZh);
    let count = 0;
    for (let i = 0; i < pending.length; i += 15) {
      const batch = pending.slice(i, i + 15);
      const result = await completeStructured({
        models,
        schema: SummaryBatch,
        systemPrompt:
          "你是技术资讯编辑。为每个条目写一句不超过 50 字的中文摘要，说明它是什么、为什么值得关注；并从 ai/frontend/backend/devops/mobile/other 中选 1-3 个标签。",
        prompt: `输出 JSON 数组，元素为 {"id","summary","tags"}。条目：\n${JSON.stringify(
          batch.map((b) => ({
            id: b.id,
            title: b.title,
            description: b.description,
            language: b.language,
            source: b.source,
          })),
        )}`,
      });
      for (const r of result) {
        const target = batch.find((b) => b.id === r.id);
        if (!target) continue;
        this.db
          .update(feedItems)
          .set({ summaryZh: r.summary, tags: r.tags.length ? r.tags : target.tags })
          .where(eq(feedItems.id, r.id))
          .run();
        count++;
      }
    }
    return count;
  }

  getDigest(date = localDate()): DailyDigest | null {
    const doc = this.digests.get(date);
    if (!doc) return null;
    const { id: _id, ...digest } = doc;
    return digest;
  }

  async generateDigest(date = localDate()): Promise<DailyDigest> {
    const items = this.list({ date, limit: 80 });
    if (items.length === 0)
      throw new AppError(ErrorCode.BadRequest, "当天还没有热榜数据，请先刷新");
    const models = await this.models.resolve("research");
    if (models.length === 0)
      throw new AppError(ErrorCode.ProviderUnavailable, "未配置模型，无法生成速览");
    const markdown = await completeText({
      models,
      systemPrompt:
        "你是一位资深工程师兼技术编辑，为一位全栈开发者写每日技术速览。按 AI / 前端 / 后端与基础设施 分组，每组挑最值得关注的 3-5 个，每条一行：**名称** — 一句话价值 + 链接。最后给出“今日建议深入”的 1 个项目和理由。使用中文 Markdown，第一行是一句 20 字以内的标题，以 # 开头。",
      prompt: JSON.stringify(
        items.map((i) => ({
          title: i.title,
          url: i.url,
          summary: i.summaryZh ?? i.description,
          tags: i.tags,
          starsToday: i.starsToday,
        })),
      ),
    });
    const headline = /^#\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? `${date} 技术速览`;
    const digest: DailyDigest = {
      date,
      headline,
      markdown,
      itemCount: items.length,
      createdAt: nowIso(),
    };
    this.digests.put({ id: date, ...digest });
    return digest;
  }
}

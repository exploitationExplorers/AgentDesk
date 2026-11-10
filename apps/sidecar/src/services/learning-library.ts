import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import type {
  GradeResult,
  ImportSourceInput,
  KnowledgeUnit,
  LearningSource,
  ReviewCard,
  ReviewQueue,
  ReviewRating,
} from "@agentdesk/shared";
import { createHash } from "node:crypto";
import { asc, count, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import {
  contentBlocks,
  knowledgeUnits,
  learningSources,
  reviewItems,
  reviewLogs,
  sourceVersions,
} from "../db/schema";
import { newId } from "../util";
import { retrievability, schedule, type MemoryState } from "./fsrs";
import { readPublicArticle } from "./insight-source";

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + days);
  return localDate(dt);
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

/**
 * 把正文切成可引用的内容块。
 *
 * 当前按空行分段再合并到 ~900 字，引用粒度是「版本内的块序号」。
 * 注意：复用的 readPublicArticle 返回的是已经抽取过的纯文本，标题层级在那一步
 * 就丢掉了，所以还做不到方案里写的「标题路径」级引用——那需要换一个保留结构的解析器。
 */
function chunk(text: string): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter((p) => p.length > 0);
  const blocks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length > 900) {
      blocks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) blocks.push(buf);
  return blocks.slice(0, 120);
}

const Unit = z.object({
  blockIndex: z.coerce.number().int().min(0),
  title: z.string().min(1),
  summary: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
});

/** 模型有时直接返回数组，有时包在 { units } 里。两种都接受。 */
const UnitDraft = z.preprocess(
  (value) => (Array.isArray(value) ? { units: value } : value),
  z.object({ units: z.array(Unit).max(40) }),
);

function titleFromArticle(raw: string, url?: string): string {
  const heading = raw
    .match(/^#{1,3}\s+(.+)$/m)?.[1]
    ?.replace(/[`*]/g, "")
    .trim();
  if (heading) return heading;
  if (url) {
    try {
      return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    } catch {
      return url;
    }
  }
  return raw.slice(0, 40);
}

export class LearningLibraryService {
  constructor(
    private readonly db: Db,
    private readonly models: ModelResolver,
  ) {}

  // ---------- 资料 ----------

  listSources(): LearningSource[] {
    const rows = this.db
      .select()
      .from(learningSources)
      .orderBy(desc(learningSources.createdAt))
      .all();
    if (rows.length === 0) return [];
    const versions = this.db
      .select()
      .from(sourceVersions)
      .where(
        inArray(
          sourceVersions.id,
          rows.map((r) => r.currentVersionId),
        ),
      )
      .all();
    const vById = new Map(versions.map((v) => [v.id, v]));
    const counts = this.db
      .select({ vid: knowledgeUnits.sourceVersionId, n: count() })
      .from(knowledgeUnits)
      .groupBy(knowledgeUnits.sourceVersionId)
      .all();
    const cById = new Map(counts.map((c) => [c.vid, Number(c.n)]));

    return rows.flatMap((r) => {
      const v = vById.get(r.currentVersionId);
      if (!v) return [];
      return [
        {
          id: r.id,
          kind: r.kind,
          originRef: r.originRef,
          title: r.title,
          currentVersionId: r.currentVersionId,
          createdAt: r.createdAt,
          charCount: v.charCount,
          blockCount: v.blockCount,
          parseQuality: v.parseQuality,
          unitCount: cById.get(r.currentVersionId) ?? 0,
        },
      ];
    });
  }

  listUnits(sourceId: string): KnowledgeUnit[] {
    const source = this.db
      .select()
      .from(learningSources)
      .where(eq(learningSources.id, sourceId))
      .get();
    if (!source) return [];
    return this.unitsForVersion(source.currentVersionId);
  }

  private unitsForVersion(versionId: string): KnowledgeUnit[] {
    const units = this.db
      .select()
      .from(knowledgeUnits)
      .where(eq(knowledgeUnits.sourceVersionId, versionId))
      .orderBy(asc(knowledgeUnits.orderIndex))
      .all();
    if (units.length === 0) return [];
    const blocks = this.db
      .select()
      .from(contentBlocks)
      .where(
        inArray(
          contentBlocks.id,
          units.map((u) => u.blockId),
        ),
      )
      .all();
    const bById = new Map(blocks.map((b) => [b.id, b.text]));
    return units.map((u) => ({
      id: u.id,
      sourceVersionId: u.sourceVersionId,
      blockId: u.blockId,
      orderIndex: u.orderIndex,
      title: u.title,
      summary: u.summary,
      question: u.question,
      answer: u.answer,
      sourceText: bById.get(u.blockId) ?? "",
    }));
  }

  /**
   * 导入一份资料：抓取或接收正文 → 快照存档 → 切块 → 提炼知识点 → 建立复习项。
   * 抓取失败时抛出的错误信息会原样回给前端，引导用户改为粘贴正文。
   */
  async importSource(input: ImportSourceInput, signal?: AbortSignal): Promise<LearningSource> {
    const raw = input.text?.trim() || (await readPublicArticle(input.url!, signal));
    const blocks = chunk(raw);
    if (blocks.length === 0) throw new Error("没有解析出可用正文");

    const title = input.title?.trim() || titleFromArticle(raw, input.url);

    const now = new Date().toISOString();
    const sourceId = newId();
    const versionId = newId();
    const blockRows = blocks.map((text, i) => ({
      id: newId(),
      sourceVersionId: versionId,
      orderIndex: i,
      text,
    }));

    // 正文被 readPublicArticle 截断到 60k 时标记为 partial，不假装解析完整。
    const parseQuality: "ok" | "partial" = raw.length >= 60_000 ? "partial" : "ok";

    this.db.transaction((tx) => {
      tx.insert(sourceVersions)
        .values({
          id: versionId,
          sourceId,
          contentHash: createHash("sha256").update(raw).digest("hex"),
          charCount: raw.length,
          blockCount: blocks.length,
          parseQuality,
          createdAt: now,
        })
        .run();
      tx.insert(learningSources)
        .values({
          id: sourceId,
          kind: input.text ? "text" : "url",
          originRef: input.url ?? "粘贴文本",
          title: title.slice(0, 120),
          currentVersionId: versionId,
          createdAt: now,
        })
        .run();
      tx.insert(contentBlocks).values(blockRows).run();
    });

    await this.buildUnits(versionId, blockRows, signal);
    return this.listSources().find((s) => s.id === sourceId)!;
  }

  /** 让模型把内容块提炼成知识点。每个知识点必须声明它来自哪个块。 */
  private async buildUnits(
    versionId: string,
    blocks: Array<{ id: string; orderIndex: number; text: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const models = await this.models.resolve("orchestrator");
    if (models.length === 0) return; // 没有模型就先只存资料，知识点留到以后再提炼

    // 控制一次送进模型的量，超长资料只处理前若干块。
    const used = blocks.slice(0, 24);
    const corpus = used
      .map((b) => `[块 ${b.orderIndex}]\n${b.text.slice(0, 1200)}`)
      .join("\n\n---\n\n");

    let parsed: z.infer<typeof UnitDraft>;
    try {
      parsed = await completeStructured({
        models,
        schema: UnitDraft,
        maxTokens: 4000,
        signal,
        systemPrompt: `你把一份学习资料拆成若干个可以单独记忆和自测的知识点。
每个知识点必须：
- blockIndex：这个知识点出自哪一个块，填该块的编号。不要编造编号，只能用出现过的。
- title：不超过 20 字的小标题。
- summary：用两三句话把这个知识点讲清楚，要能独立看懂，不要写"如上所述"。
- question：一个能检验是否真的掌握的问题，不要问"是什么意思"这种可以照抄原文的问题。
- answer：这个问题的参考答案，三句以内。
只提炼资料里真实存在的内容，资料没讲的不要补充。知识点数量按资料长度决定，不要为了凑数拆得过细。
输出 JSON 对象：{"units":[{"blockIndex":0,"title":"","summary":"","question":"","answer":""}]}。`,
        prompt: corpus,
      });
    } catch (error) {
      // 资料已经存档；把失败原因打出来，避免页面只显示「没有模型」。
      console.error("[learning] 知识点提炼失败", error instanceof Error ? error.message : error);
      return;
    }

    const byIndex = new Map(used.map((b) => [b.orderIndex, b.id]));
    const now = new Date().toISOString();
    const today = localDate();
    const rows = parsed.units
      .map((u, i) => {
        const blockId = byIndex.get(u.blockIndex);
        if (!blockId) return null; // 模型给了不存在的块号，丢弃而不是硬塞一个引用
        return {
          id: newId(),
          sourceVersionId: versionId,
          blockId,
          orderIndex: i,
          title: u.title.slice(0, 120),
          summary: u.summary,
          question: u.question,
          answer: u.answer,
          createdAt: now,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return;

    this.db.transaction((tx) => {
      tx.insert(knowledgeUnits).values(rows).run();
      tx.insert(reviewItems)
        .values(
          rows.map((r) => ({
            id: newId(),
            knowledgeUnitId: r.id,
            stability: null,
            difficulty: null,
            dueDate: today, // 新知识点当天即可首次学习
            lastReviewedAt: null,
            reps: 0,
            lapses: 0,
          })),
        )
        .run();
    });
  }

  deleteSource(id: string): void {
    const source = this.db.select().from(learningSources).where(eq(learningSources.id, id)).get();
    if (!source) return;
    const versions = this.db
      .select({ id: sourceVersions.id })
      .from(sourceVersions)
      .where(eq(sourceVersions.sourceId, id))
      .all()
      .map((v) => v.id);
    const units = versions.length
      ? this.db
          .select({ id: knowledgeUnits.id })
          .from(knowledgeUnits)
          .where(inArray(knowledgeUnits.sourceVersionId, versions))
          .all()
          .map((u) => u.id)
      : [];
    this.db.transaction((tx) => {
      if (units.length) {
        const items = tx
          .select({ id: reviewItems.id })
          .from(reviewItems)
          .where(inArray(reviewItems.knowledgeUnitId, units))
          .all()
          .map((i) => i.id);
        if (items.length)
          tx.delete(reviewLogs).where(inArray(reviewLogs.reviewItemId, items)).run();
        tx.delete(reviewItems).where(inArray(reviewItems.knowledgeUnitId, units)).run();
        tx.delete(knowledgeUnits).where(inArray(knowledgeUnits.id, units)).run();
      }
      if (versions.length) {
        tx.delete(contentBlocks).where(inArray(contentBlocks.sourceVersionId, versions)).run();
        tx.delete(sourceVersions).where(eq(sourceVersions.sourceId, id)).run();
      }
      tx.delete(learningSources).where(eq(learningSources.id, id)).run();
    });
  }

  // ---------- 复习 ----------

  /** 今日复习队列。到期优先、逾期越久越靠前；纯查询+排序，不调用模型。 */
  reviewQueue(date = localDate(), limit = 30): ReviewQueue {
    const total = this.db.select({ n: count() }).from(knowledgeUnits).get();
    const due = this.db
      .select()
      .from(reviewItems)
      .where(lte(reviewItems.dueDate, date))
      .orderBy(asc(reviewItems.dueDate))
      .all();

    const unitIds = due.map((i) => i.knowledgeUnitId);
    const units = unitIds.length
      ? this.db.select().from(knowledgeUnits).where(inArray(knowledgeUnits.id, unitIds)).all()
      : [];
    const uById = new Map(units.map((u) => [u.id, u]));

    const blockIds = units.map((u) => u.blockId);
    const blocks = blockIds.length
      ? this.db.select().from(contentBlocks).where(inArray(contentBlocks.id, blockIds)).all()
      : [];
    const bById = new Map(blocks.map((b) => [b.id, b.text]));

    const versionIds = [...new Set(units.map((u) => u.sourceVersionId))];
    const srcs = versionIds.length
      ? this.db
          .select()
          .from(learningSources)
          .where(inArray(learningSources.currentVersionId, versionIds))
          .all()
      : [];
    const sByVersion = new Map(srcs.map((s) => [s.currentVersionId, s.title]));

    const cards: ReviewCard[] = due.flatMap((item) => {
      const u = uById.get(item.knowledgeUnitId);
      if (!u) return [];
      const elapsed = item.lastReviewedAt ? daysBetween(item.lastReviewedAt.slice(0, 10), date) : 0;
      return [
        {
          itemId: item.id,
          unit: {
            id: u.id,
            sourceVersionId: u.sourceVersionId,
            blockId: u.blockId,
            orderIndex: u.orderIndex,
            title: u.title,
            summary: u.summary,
            question: u.question,
            answer: u.answer,
            sourceText: bById.get(u.blockId) ?? "",
          },
          sourceTitle: sByVersion.get(u.sourceVersionId) ?? "已更新的资料",
          dueDate: item.dueDate,
          reps: item.reps,
          lapses: item.lapses,
          stability: item.stability,
          difficulty: item.difficulty,
          retrievability: item.stability ? retrievability(elapsed, item.stability) : null,
          overdue: item.dueDate < date,
        },
      ];
    });

    // 复习过且逾期的排前面，全新的排后面，避免新内容挤掉该巩固的。
    cards.sort((a, b) => {
      if ((a.reps === 0) !== (b.reps === 0)) return a.reps === 0 ? 1 : -1;
      return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
    });

    return {
      date,
      cards: cards.slice(0, limit),
      totalUnits: Number(total?.n ?? 0),
      dueCount: cards.length,
      newCount: cards.filter((c) => c.reps === 0).length,
    };
  }

  dueCount(date = localDate()): number {
    const row = this.db
      .select({ n: count() })
      .from(reviewItems)
      .where(lte(reviewItems.dueDate, date))
      .get();
    return Number(row?.n ?? 0);
  }

  /** 提交一次复习评分，推进 FSRS 状态并写入复习日志。 */
  grade(itemId: string, rating: ReviewRating, date = localDate()): GradeResult {
    const item = this.db.select().from(reviewItems).where(eq(reviewItems.id, itemId)).get();
    if (!item) throw new Error("复习项不存在");

    const elapsed = item.lastReviewedAt ? daysBetween(item.lastReviewedAt.slice(0, 10), date) : 0;
    const prev: MemoryState | null =
      item.stability != null && item.difficulty != null
        ? { stability: item.stability, difficulty: item.difficulty }
        : null;

    const next = schedule(prev, rating, elapsed);
    const now = new Date().toISOString();
    const dueDate = shiftDate(date, next.intervalDays);

    this.db.transaction((tx) => {
      tx.update(reviewItems)
        .set({
          stability: next.stability,
          difficulty: next.difficulty,
          dueDate,
          lastReviewedAt: now,
          reps: item.reps + 1,
          lapses: item.lapses + (rating === 1 ? 1 : 0),
        })
        .where(eq(reviewItems.id, itemId))
        .run();
      tx.insert(reviewLogs)
        .values({
          id: newId(),
          reviewItemId: itemId,
          rating,
          elapsedDays: elapsed,
          retrievability: next.retrievability,
          stabilityAfter: next.stability,
          reviewedAt: now,
        })
        .run();
    });

    return {
      itemId,
      stability: next.stability,
      difficulty: next.difficulty,
      intervalDays: next.intervalDays,
      dueDate,
    };
  }
}

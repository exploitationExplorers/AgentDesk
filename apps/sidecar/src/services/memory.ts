import type Database from "better-sqlite3";
import { z } from "zod";
import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import {
  AppError,
  ErrorCode,
  Memory,
  MemoryKind,
  type MemoryDeleted,
  type MemoryKind as MemoryKindValue,
  type MemorySource,
} from "@agentdesk/shared";
import { newId, nowIso } from "../util";

const CJK_STOP = new Set(
  "的了是在我你吗呢吧啊哦呀和与或及把被就也都还很这那个有不没到从对为而什哪怎么".split(""),
);

const Extraction = z.object({
  memories: z
    .array(
      z.object({
        text: z.string().min(1).max(280),
        kind: MemoryKind,
      }),
    )
    .max(3),
});

interface MemoryRow {
  id: string;
  namespace: string;
  kind: string;
  text: string;
  tokens: string;
  source: string;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreMemoryInput {
  text: string;
  kind: MemoryKindValue;
  source: MemorySource;
  namespace?: string;
  conversationId?: string | null;
}

/** 英文词与中文双字。整句中文没有空格，FTS5 的 unicode61 无法按词切开。 */
export function memoryTokens(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
  for (const seq of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = [...seq];
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i] ?? "";
      const b = chars[i + 1] ?? "";
      if (CJK_STOP.has(a) || CJK_STOP.has(b)) continue;
      tokens.add(a + b);
    }
  }
  return [...tokens];
}

export function ftsMatchQuery(text: string): string | null {
  const tokens = memoryTokens(text).slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function rowToMemory(row: MemoryRow): Memory {
  return Memory.parse({
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    text: row.text,
    source: row.source,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const KIND_LABEL: Record<MemoryKindValue, string> = {
  preference: "偏好",
  fact: "事实",
  decision: "决定",
};

/**
 * 长期记忆：同一命名空间正文相同则更新，召回走 FTS5 BM25。
 * 抽取失败只记日志，不把错误抛回对话。
 */
export class MemoryService {
  private readonly insert;
  private readonly findDup;
  private readonly touch;
  private readonly remove;
  private readonly selectById;
  private readonly selectAll;
  private readonly byNamespace;
  private readonly recallStmt;

  constructor(
    private readonly raw: Database.Database,
    private readonly models: ModelResolver,
  ) {
    this.insert = raw.prepare(
      `INSERT INTO memories (id, namespace, kind, text, tokens, source, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findDup = raw.prepare(`SELECT * FROM memories WHERE namespace = ? AND text = ?`);
    this.touch = raw.prepare(
      `UPDATE memories SET kind = ?, source = ?, conversation_id = ?, updated_at = ? WHERE id = ?`,
    );
    this.remove = raw.prepare(`DELETE FROM memories WHERE id = ?`);
    this.selectById = raw.prepare(`SELECT * FROM memories WHERE id = ?`);
    this.selectAll = raw.prepare(`SELECT * FROM memories ORDER BY updated_at DESC`);
    this.byNamespace = raw.prepare(
      `SELECT * FROM memories WHERE namespace = ? ORDER BY updated_at DESC`,
    );
    this.recallStmt = raw.prepare(
      `SELECT m.* FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.namespace = ?
       ORDER BY bm25(memories_fts)
       LIMIT ?`,
    );
  }

  store(input: StoreMemoryInput): { memory: Memory; created: boolean } {
    const text = normalizeMemoryText(input.text);
    if (text.length < 2) throw new AppError(ErrorCode.BadRequest, "记忆内容过短");
    const kind = MemoryKind.parse(input.kind);
    const namespace = (input.namespace ?? "user").trim() || "user";
    if (!/^[\w.-]{1,64}$/.test(namespace)) {
      throw new AppError(ErrorCode.BadRequest, "记忆命名空间无效");
    }
    const now = nowIso();
    const existing = this.findDup.get(namespace, text) as MemoryRow | undefined;
    if (existing) {
      this.touch.run(
        kind,
        input.source,
        input.conversationId ?? existing.conversation_id,
        now,
        existing.id,
      );
      return { memory: this.mustGet(existing.id), created: false };
    }
    const id = newId();
    this.insert.run(
      id,
      namespace,
      kind,
      text,
      memoryTokens(text).join(" "),
      input.source,
      input.conversationId ?? null,
      now,
      now,
    );
    return { memory: this.mustGet(id), created: true };
  }

  get(id: string): Memory | undefined {
    const row = this.selectById.get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  list(): Memory[] {
    return (this.selectAll.all() as MemoryRow[]).map(rowToMemory);
  }

  forget(id: string): MemoryDeleted {
    const result = this.remove.run(id);
    if (result.changes === 0) throw new AppError(ErrorCode.NotFound, "记忆不存在");
    return { id, deleted: true };
  }

  /** 用用户原话召回。没有可用检索词时返回空，不把无关记忆塞进上下文。 */
  recall(query: string, options?: { limit?: number; namespace?: string }): Memory[] {
    const limit = Math.min(20, Math.max(1, options?.limit ?? 5));
    const namespace = options?.namespace ?? "user";
    const match = ftsMatchQuery(query);
    if (!match) return [];
    try {
      return (this.recallStmt.all(match, namespace, limit) as MemoryRow[]).map(rowToMemory);
    } catch (error) {
      console.error("[memory] fts recall failed", error);
      return this.recallByOverlap(query, namespace, limit);
    }
  }

  formatForPrompt(items: Memory[]): string {
    if (items.length === 0) return "";
    const body = items.map((item) => `- [${KIND_LABEL[item.kind]}] ${item.text}`).join("\n");
    return `相关长期记忆（来自以往对话，仅供参考；与当前问题无关就忽略）：\n${body}`;
  }

  /**
   * 从一轮成功对话里抽取最多 3 条可长期保留的信息。
   * 模型不可用或输出不合法时返回空数组。
   */
  async captureFromTurn(input: {
    userText: string;
    assistantText: string;
    conversationId: string;
    signal?: AbortSignal;
  }): Promise<Memory[]> {
    try {
      const assistant = input.assistantText.trim();
      if (!assistant || assistant.startsWith("出错了：")) return [];
      if (input.signal?.aborted) return [];
      const models = await this.models.resolve("orchestrator");
      if (models.length === 0) return [];
      const parsed = await completeStructured({
        models,
        schema: Extraction,
        maxTokens: 400,
        signal: input.signal,
        systemPrompt: `你从一轮对话里抽取值得长期记住的信息。只保留稳定的用户偏好、关于用户项目或环境的事实、以及用户做出的决定。
不要记录寒暄、一次性问题、临时任务进度、工具报错或助手自己的猜测。
没有值得保留的内容时 memories 为空数组。每条 text 用一句中文，不超过 80 字。最多 3 条。
kind 只能是 preference、fact、decision。`,
        prompt: `用户：${input.userText.slice(0, 2000)}\n\n助手：${assistant.slice(0, 2000)}`,
      });
      const stored: Memory[] = [];
      for (const item of parsed.memories) {
        const text = normalizeMemoryText(item.text);
        if (text.length < 4) continue;
        stored.push(
          this.store({
            text,
            kind: item.kind,
            source: "auto",
            conversationId: input.conversationId,
          }).memory,
        );
      }
      return stored;
    } catch (error) {
      console.error("[memory] capture failed", error);
      return [];
    }
  }

  private mustGet(id: string): Memory {
    const memory = this.get(id);
    if (!memory) throw new AppError(ErrorCode.Internal, "记忆写入后读取失败");
    return memory;
  }

  private recallByOverlap(query: string, namespace: string, limit: number): Memory[] {
    const wanted = new Set(memoryTokens(query));
    if (wanted.size === 0) return [];
    return (this.byNamespace.all(namespace) as MemoryRow[])
      .map((row) => ({
        row,
        score: row.tokens.split(" ").filter((token) => token && wanted.has(token)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => rowToMemory(item.row));
  }
}

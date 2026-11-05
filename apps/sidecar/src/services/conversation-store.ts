import { asc, eq } from "drizzle-orm";
import type { Message } from "@agentdesk/agent-core";
import type { AgentName, ChatMessage } from "@agentdesk/shared";
import type { Db } from "../db/client";
import { messages } from "../db/schema";
import { toJsonSafe } from "../util";
import { summarizeToolCalls } from "./run-tool-history";
import { Collection } from "../db/collection";

/** 历史消息只回放文本；工具调用细节以摘要附在助手消息后，控制上下文长度。 */
function toPiMessages(history: ChatMessage[]): Message[] {
  return history.map((m): Message => {
    if (m.role === "user")
      return { role: "user", content: m.content, timestamp: Date.parse(m.createdAt) };
    const toolNote = m.toolCalls.length
      ? `\n\n(内部执行记录，仅用于续跑时核对，不向用户复述：${summarizeToolCalls(m.toolCalls)})`
      : "";
    return {
      role: "assistant",
      content: [{ type: "text", text: `${m.content}${toolNote}` }],
      api: "openai-completions",
      provider: "history",
      model: "history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.parse(m.createdAt),
    };
  });
}

/** 会话消息的裸持久化：插入、按会话查询、转换成 pi 消息格式。供 ChatService 和 Task executor 共用。 */
export class ConversationStore {
  private readonly progress: Collection<{
    id: string;
    blocks: NonNullable<ChatMessage["display"]>;
  }>;
  constructor(private readonly db: Db) {
    this.progress = new Collection(db, "message_progress");
  }

  deleteProgress(conversationId: string): void {
    for (const message of this.listMessages(conversationId)) this.progress.delete(message.id);
  }

  listMessages(conversationId: string): ChatMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all()
      .map((r) => ({
        ...r,
        agent: r.agent as AgentName | null,
        toolCalls: r.toolCalls as ChatMessage["toolCalls"],
        display: this.progress.get(r.id)?.blocks,
      }));
  }

  insertMessage(message: ChatMessage): void {
    const { display, ...record } = message;
    this.db.transaction(() => {
      this.db.insert(messages).values(toJsonSafe(record)).run();
      if (display?.length) this.progress.put({ id: message.id, blocks: display });
    });
  }

  toPiMessages(history: ChatMessage[]): Message[] {
    return toPiMessages(history);
  }
}

import { asc, desc, eq } from "drizzle-orm";
import type { Message, Orchestrator } from "@agentdesk/agent-core";
import {
  AppError,
  ChatRequest,
  ErrorCode,
  type AgentName,
  type AgentStreamEvent,
  type ChatMessage,
  type Conversation,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { messages, traces } from "../db/schema";
import { errorMessage, newId, nowIso, toJsonSafe } from "../util";
import type { ApprovalService } from "./approvals";
import type { MemoryService } from "./memory";

const HISTORY_LIMIT = 20;

/** 历史消息只回放文本；工具调用细节以摘要附在助手消息后，控制上下文长度。 */
function toPiMessages(history: ChatMessage[]): Message[] {
  return history.slice(-HISTORY_LIMIT).map((m): Message => {
    if (m.role === "user")
      return { role: "user", content: m.content, timestamp: Date.parse(m.createdAt) };
    const toolNote = m.toolCalls.length
      ? `\n\n(本轮调用了工具：${[...new Set(m.toolCalls.map((t) => t.name))].join(", ")})`
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

export class ChatService {
  private readonly conversations: Collection<Conversation>;

  constructor(
    private readonly db: Db,
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalService,
    private readonly memory: MemoryService,
  ) {
    this.conversations = new Collection<Conversation>(db, "conversations");
  }

  listConversations(): Conversation[] {
    return this.conversations.list();
  }

  messages(conversationId: string): ChatMessage[] {
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
      }));
  }

  deleteConversation(id: string): void {
    this.db.delete(messages).where(eq(messages.conversationId, id)).run();
    this.db
      .delete(traces)
      .where(eq(traces.scope, `chat:${id}`))
      .run();
    this.conversations.delete(id);
  }

  traces(conversationId: string, limit = 500) {
    return this.db
      .select()
      .from(traces)
      .where(eq(traces.scope, `chat:${conversationId}`))
      .orderBy(desc(traces.id))
      .limit(limit)
      .all()
      .reverse();
  }

  private insertMessage(message: ChatMessage) {
    this.db.insert(messages).values(toJsonSafe(message)).run();
  }

  /**
   * 处理一轮对话，事件通过 emit 流式推送。
   * 返回会话 ID；全部事件同时写入 traces 便于回放。
   */
  async send(
    input: unknown,
    emit: (event: AgentStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const req = ChatRequest.parse(input);
    let conversation = req.conversationId ? this.conversations.get(req.conversationId) : undefined;
    if (req.conversationId && !conversation) throw new AppError(ErrorCode.NotFound, "会话不存在");
    if (!conversation) {
      conversation = this.conversations.put({
        id: newId(),
        title: req.message.slice(0, 40),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    const conversationId = conversation.id;
    const history = this.messages(conversationId);
    this.insertMessage({
      id: newId(),
      conversationId,
      role: "user",
      content: req.message,
      agent: null,
      toolCalls: [],
      createdAt: nowIso(),
    });

    const scope = `chat:${conversationId}`;
    const traced = (event: AgentStreamEvent) => {
      if (event.type !== "text_delta") {
        this.db
          .insert(traces)
          .values({ scope, event: toJsonSafe(event), createdAt: nowIso() })
          .run();
      }
      emit(event);
    };

    emit({ type: "conversation", conversationId });
    const assistantId = newId();
    let text = "";
    let context: string | undefined;
    try {
      context = this.memory.formatForPrompt(this.memory.recall(req.message)) || undefined;
    } catch (error) {
      console.error("[memory] recall failed", error);
    }
    try {
      const result = await this.orchestrator.run({
        history: toPiMessages(history),
        userMessage: req.message,
        agent: req.agent,
        context,
        signal,
        emit: traced,
        requestApproval: (request) =>
          this.approvals.request({ kind: "tool", ...request }, signal, (approval) =>
            traced({
              type: "approval_required",
              approvalId: approval.id,
              title: approval.title,
              detail: approval.detail,
            }),
          ),
      });
      text = result.text;
      this.insertMessage({
        id: assistantId,
        conversationId,
        role: "assistant",
        content: text,
        agent: result.agent,
        toolCalls: result.toolCalls,
        createdAt: nowIso(),
      });
      try {
        await this.memory.captureFromTurn({
          userText: req.message,
          assistantText: text,
          conversationId,
          signal,
        });
      } catch (error) {
        console.error("[memory] capture failed", error);
      }
    } catch (error) {
      const message = errorMessage(error);
      traced({ type: "error", message });
      this.insertMessage({
        id: assistantId,
        conversationId,
        role: "assistant",
        content: `出错了：${message}`,
        agent: null,
        toolCalls: [],
        createdAt: nowIso(),
      });
    }
    this.conversations.put({ ...conversation, updatedAt: nowIso() });
    traced({ type: "done", messageId: assistantId });
    return conversationId;
  }
}

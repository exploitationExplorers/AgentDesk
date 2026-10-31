import { desc, eq } from "drizzle-orm";
import type { ApprovalRequest, Orchestrator } from "@agentdesk/agent-core";
import {
  AppError,
  ChatRequest,
  ErrorCode,
  type AgentStreamEvent,
  type ChatMessage,
  type Conversation,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { messages, traces } from "../db/schema";
import { errorMessage, newId, nowIso, toJsonSafe } from "../util";
import type { ApprovalService } from "./approvals";
import { ConversationStore } from "./conversation-store";
import type { MemoryService } from "./memory";
import type { ProjectInstructionService } from "./project-instructions";
import { createDelegateHandler } from "./task-executor";
import type { TaskService } from "./tasks";

export class ChatService {
  private readonly conversations: Collection<Conversation>;
  private readonly conversationStore: ConversationStore;

  constructor(
    private readonly db: Db,
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalService,
    private readonly memory: MemoryService,
    private readonly tasks: TaskService,
    private readonly projectInstructions: ProjectInstructionService,
  ) {
    this.conversations = new Collection<Conversation>(db, "conversations");
    this.conversationStore = new ConversationStore(db);
  }

  listConversations(): Conversation[] {
    return this.conversations.list();
  }

  messages(conversationId: string): ChatMessage[] {
    return this.conversationStore.listMessages(conversationId);
  }

  deleteConversation(id: string): void {
    this.db.delete(messages).where(eq(messages.conversationId, id)).run();
    this.db
      .delete(traces)
      .where(eq(traces.scope, `chat:${id}`))
      .run();
    this.conversations.delete(id);
  }

  renameConversation(id: string, title: string): Conversation {
    const current = this.conversations.get(id);
    if (!current) throw new AppError(ErrorCode.NotFound, "会话不存在");
    return this.conversations.put({ ...current, title, updatedAt: nowIso() });
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
    this.conversationStore.insertMessage(message);
  }

  /**
   * 不影响 /chat 本身的响应：找不到或创建失败时返回 null，由调用方 best-effort 忽略。
   * 同一个 conversationId 复用同一个 Task，每轮对话各自一条 Run。
   */
  private shadowTaskFor(
    conversationId: string,
    userMessage: string,
    agent: ChatRequest["agent"],
    controller: AbortController,
    workspace?: string,
  ): { taskId: string; runId: string } | null {
    try {
      const previous = this.tasks.findByConversation(conversationId);
      const effectiveWorkspace =
        workspace ??
        (previous?.currentRunId
          ? this.tasks.getRun(previous.currentRunId)?.input.workspace
          : undefined);
      const existing =
        previous && !["closed", "completed"].includes(previous.status) ? previous : undefined;
      const task =
        existing ??
        this.tasks.create({
          goal: userMessage,
          agent,
          conversationId,
          requiresPlanApproval: false,
        });
      const run = this.tasks.createRun({
        taskId: task.id,
        kind: "root",
        agent: agent ?? task.agent ?? "orchestrator",
        trigger: existing ? "followup" : "create",
        input: { userMessage, workspace: effectiveWorkspace },
      });
      this.tasks.startRunDirect(run.id, controller);
      return { taskId: task.id, runId: run.id };
    } catch (error) {
      console.error("[tasks] shadow task 创建失败", error);
      return null;
    }
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
    const workspace = await this.projectInstructions.validateWorkspace(req.workspace);
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
    const controller = new AbortController();
    signal = AbortSignal.any([signal, controller.signal]);
    const shadow = this.shadowTaskFor(
      conversationId,
      req.message,
      req.agent,
      controller,
      workspace,
    );
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
    const forwardToShadow = (event: AgentStreamEvent) => {
      traced(event);
      if (shadow) {
        try {
          this.tasks.appendEvent({
            taskId: shadow.taskId,
            runId: shadow.runId,
            parentRunId: null,
            event,
          });
        } catch (error) {
          console.error("[tasks] shadow 事件转发失败", error);
        }
      }
    };

    emit({ type: "conversation", conversationId });
    const assistantId = newId();
    const requestAnswer = (request: ApprovalRequest): Promise<string> => {
      let approvalId = "";
      return this.approvals
        .request({ kind: "question", ...request }, signal, (approval) => {
          approvalId = approval.id;
          forwardToShadow({
            type: "approval_required",
            approvalId: approval.id,
            title: approval.title,
            detail: approval.detail,
          });
        })
        .then((approved) => {
          if (!approved) throw new Error("用户未回答该问题（审批被拒绝或已过期）");
          const resolved = this.approvals.list("approved").find((a) => a.id === approvalId);
          const payload = resolved?.payload as { answer?: string } | undefined;
          if (!payload?.answer) throw new Error("未获取到用户回答");
          return payload.answer;
        });
    };
    let text = "";
    let context: string | undefined;
    try {
      context = this.memory.formatForPrompt(this.memory.recall(req.message)) || undefined;
    } catch (error) {
      console.error("[memory] recall failed", error);
    }
    try {
      const effectiveWorkspace = shadow
        ? this.tasks.getRun(shadow.runId)?.input.workspace
        : workspace;
      const projectContext = await this.projectInstructions.load(effectiveWorkspace, signal);
      context = [context, projectContext].filter(Boolean).join("\n\n") || undefined;
      const result = await this.orchestrator.run({
        history: this.conversationStore.toPiMessages(history),
        userMessage: req.message,
        agent: req.agent,
        modelSelection: req.modelSelection,
        context,
        signal,
        emit: forwardToShadow,
        requestApproval: (request) =>
          this.approvals.request({ kind: "tool", ...request }, signal, (approval) =>
            forwardToShadow({
              type: "approval_required",
              approvalId: approval.id,
              title: approval.title,
              detail: approval.detail,
            }),
          ),
        requestAnswer,
        onDelegate: shadow
          ? createDelegateHandler({
              tasks: this.tasks,
              approvals: this.approvals,
              taskId: shadow.taskId,
              parentRunId: shadow.runId,
              signal,
              onAgentEvent: traced,
            })
          : undefined,
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
      if (shadow) {
        try {
          this.tasks.finalizeRunDirect(shadow.runId, {
            status: "succeeded",
            resultText: text,
            toolCalls: result.toolCalls,
          });
          this.tasks.appendEvent({
            taskId: shadow.taskId,
            runId: shadow.runId,
            event: { type: "run_ended", runId: shadow.runId, status: "succeeded" },
          });
        } catch (error) {
          console.error("[tasks] shadow run 落地失败", error);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      forwardToShadow({ type: "error", message });
      this.insertMessage({
        id: assistantId,
        conversationId,
        role: "assistant",
        content: `出错了：${message}`,
        agent: null,
        toolCalls: [],
        createdAt: nowIso(),
      });
      if (shadow) {
        try {
          const status = signal.aborted ? "cancelled" : "failed";
          this.tasks.finalizeRunDirect(shadow.runId, { status, resultError: message });
          this.tasks.appendEvent({
            taskId: shadow.taskId,
            runId: shadow.runId,
            event: { type: "run_ended", runId: shadow.runId, status, error: message },
          });
        } catch (shadowError) {
          console.error("[tasks] shadow run 落地失败", shadowError);
        }
      }
    }
    this.conversations.put({
      ...(this.conversations.get(conversationId) ?? conversation),
      updatedAt: nowIso(),
    });
    traced({ type: "done", messageId: assistantId });
    return conversationId;
  }
}

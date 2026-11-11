import { desc, eq } from "drizzle-orm";
import type { ApprovalRequest, AutoApprove, MaskStore, Orchestrator } from "@agentdesk/agent-core";
import {
  AppError,
  ChatRequest,
  ErrorCode,
  runFailureMessage,
  emptyChatProgress,
  reduceChatProgress,
  type AgentStreamEvent,
  type ChatMessage,
  type Conversation,
  type ConversationPatch,
  type ConversationQuery,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { messages, traces } from "../db/schema";
import { errorMessage, newId, nowIso, toJsonSafe } from "../util";
import type { ApprovalService } from "./approvals";
import { ConversationStore } from "./conversation-store";
import { ConversationService } from "./conversations";
import type { ConversationContextService } from "./conversation-context";
import {
  acquireConversation,
  conversationActivity,
  releaseConversation,
} from "./conversation-activity";
import type { MemoryService } from "./memory";
import { formatBehaviorGuidance, type EvolutionService } from "./evolution";
import type { ProjectInstructionService } from "./project-instructions";
import { createDelegateHandler } from "./task-executor";
import type { TaskService } from "./tasks";
import { readRunToolHistory, RunToolHistory } from "./run-tool-history";

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "closed"]);

export class ChatService {
  readonly conversations: ConversationService;
  private readonly conversationStore: ConversationStore;
  private contextService?: ConversationContextService;
  private evolutionService?: EvolutionService;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  stop(conversationId: string): void {
    this.getConversation(conversationId);
    this.active.get(conversationId)?.controller.abort();
  }

  async dispose(): Promise<void> {
    const active = [...this.active.values()];
    active.forEach(({ controller }) => controller.abort());
    await Promise.allSettled(active.map(({ done }) => done));
  }

  setContextService(service: ConversationContextService): void {
    this.contextService = service;
  }

  setEvolutionService(service: EvolutionService): void {
    this.evolutionService = service;
  }

  constructor(
    private readonly db: Db,
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalService,
    private readonly memory: MemoryService,
    private readonly tasks: TaskService,
    private readonly projectInstructions: ProjectInstructionService,
    private readonly autoApprove: AutoApprove,
    private readonly maskFactory: () => MaskStore | undefined,
  ) {
    this.conversations = new ConversationService(db);
    this.conversationStore = new ConversationStore(db);
  }

  listConversations(query: ConversationQuery = {}): Conversation[] {
    return this.conversations.list(query);
  }

  getConversation(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new AppError(ErrorCode.NotFound, "会话不存在");
    return conversation;
  }

  messages(conversationId: string): ChatMessage[] {
    return this.conversationStore.listMessages(conversationId);
  }

  async deleteConversation(id: string, options: { force?: boolean } = {}): Promise<void> {
    this.getConversation(id);
    const task = this.tasks.findByConversation(id);
    if (task?.automationId && !TERMINAL_TASK.has(task.status)) {
      throw new AppError(ErrorCode.Conflict, "自动化会话仍在执行，暂不能删除");
    }

    // 单条删除先检查执行、压缩和排队，避免提前释放其他操作持有的锁。
    if (!options.force) this.tasks.assertConversationAvailable(id);

    const inflight = this.active.get(id);
    if (inflight) {
      inflight.controller.abort();
      // 模型调用可能不立刻响应 abort；限时等待后强制释放并删除，避免清空卡死。
      await Promise.race([
        inflight.done.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, options.force ? 250 : 1500)),
      ]);
    }
    releaseConversation(id);

    this.conversationStore.deleteProgress(id);
    this.contextService?.forget(id);
    this.db.delete(messages).where(eq(messages.conversationId, id)).run();
    this.db
      .delete(traces)
      .where(eq(traces.scope, `chat:${id}`))
      .run();
    this.conversations.delete(id);
  }

  async clearConversations(ids: string[]): Promise<{
    deleted: string[];
    skipped: Array<{ id: string; title: string; reason: string }>;
  }> {
    const deleted: string[] = [];
    const skipped: Array<{ id: string; title: string; reason: string }> = [];
    for (const id of ids) {
      const current = this.conversations.get(id);
      if (!current) {
        deleted.push(id);
        continue;
      }
      try {
        await this.deleteConversation(id, { force: true });
        deleted.push(id);
      } catch (error) {
        skipped.push({ id, title: current.title, reason: errorMessage(error) });
      }
    }
    return { deleted, skipped };
  }

  renameConversation(id: string, title: string): Conversation {
    return this.patchConversation(id, { title });
  }

  patchConversation(id: string, patch: ConversationPatch): Conversation {
    if (patch.projectId !== undefined && this.tasks.findByConversation(id)?.automationId)
      throw new AppError(ErrorCode.Conflict, "自动化工作区由创建时的绑定决定，不能在会话中更换");
    if (patch.projectId !== undefined && conversationActivity(id)) {
      throw new AppError(ErrorCode.Conflict, "请等待当前会话处理完成后再更换关联项目");
    }
    const task = this.tasks.findByConversation(id);
    if (
      patch.projectId !== undefined &&
      task &&
      ["running", "planning", "queued", "awaiting_plan_approval"].includes(task.status)
    ) {
      throw new AppError(ErrorCode.Conflict, "请等待当前任务结束后再更换关联项目");
    }
    return this.conversations.patch(id, patch);
  }

  conversationWorkspace(id?: string, workspace?: string): string | undefined {
    if (workspace !== undefined || !id) return workspace;
    const linked = this.conversations.projectWorkspace(id);
    if (linked || this.conversations.hasProjectBinding(id)) return linked;
    // 旧会话尚无项目关联字段时，沿用已有 Run 的工作区。
    const task = this.tasks.findByConversation(id);
    return task?.currentRunId ? this.tasks.getRun(task.currentRunId)?.input.workspace : undefined;
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
      const effectiveWorkspace = workspace;
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
        inheritWorkspace: false,
        conversationLockHeld: true,
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
    if (req.conversationId && this.tasks.findByConversation(req.conversationId)?.automationId)
      throw new AppError(ErrorCode.Conflict, "请通过自动化会话中的回答或继续修改操作提交请求");
    const workspace = await this.projectInstructions.validateWorkspace(
      this.conversationWorkspace(req.conversationId, req.workspace),
    );
    let conversation = req.conversationId ? this.conversations.get(req.conversationId) : undefined;
    if (req.conversationId && !conversation) throw new AppError(ErrorCode.NotFound, "会话不存在");
    if (!conversation) {
      conversation = this.conversations.put({
        id: newId(),
        title: req.message.slice(0, 40),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        projectId: workspace ? this.conversations.projectIdForWorkspace(workspace) : null,
      });
    } else if (!this.conversations.hasProjectBinding(conversation.id)) {
      conversation = this.conversations.put({
        ...conversation,
        projectId: workspace ? this.conversations.projectIdForWorkspace(workspace) : null,
      });
    }
    const conversationId = conversation.id;
    if (
      req.conversationId &&
      this.tasks.findByConversation(conversationId)?.purpose === "reference_analysis"
    ) {
      throw new AppError(
        ErrorCode.Conflict,
        "请从项目中心选择资料建议创建开发任务，或重新提交资料分析",
      );
    }
    this.tasks.assertConversationAvailable(conversationId);
    const release = acquireConversation(conversationId, "running");
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.set(conversationId, { controller, done });
    try {
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
      let progress = emptyChatProgress();
      const traced = (event: AgentStreamEvent) => {
        progress = reduceChatProgress(progress, event);
        if (event.type !== "text_delta") {
          this.db
            .insert(traces)
            .values({ scope, event: toJsonSafe(event), createdAt: nowIso() })
            .run();
        }
        emit(event);
      };
      const turnTools = new RunToolHistory();
      const forwardToShadow = (event: AgentStreamEvent) => {
        traced(event);
        turnTools.append(event);
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
          .request({ kind: "question", ...request, conversationId }, signal, (approval) => {
            approvalId = approval.id;
            forwardToShadow({
              type: "approval_required",
              approvalId: approval.id,
              title: approval.title,
              detail: approval.detail,
              risk: approval.risk,
              payload: approval.payload,
              reason: approval.reason,
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
      const effectiveWorkspace = shadow
        ? this.tasks.getRun(shadow.runId)?.input.workspace
        : workspace;
      const memoryContext = { workspace: effectiveWorkspace, conversationId };
      try {
        context =
          this.memory.withContext(memoryContext, () =>
            this.memory.formatForPrompt(this.memory.recall(req.message)),
          ) || undefined;
      } catch (error) {
        console.error("[memory] recall failed", error);
      }
      try {
        const projectContext = await this.projectInstructions.load(effectiveWorkspace, signal);
        const behavior = this.evolutionService?.pin(
          shadow?.runId ?? `chat:${conversationId}:${assistantId}`,
        );
        const guidance = behavior ? formatBehaviorGuidance(behavior) : undefined;
        context = [context, projectContext, guidance].filter(Boolean).join("\n\n") || undefined;
        const prepared = await this.contextService?.prepare({
          conversationId,
          history,
          userMessage: req.message,
          systemContext: context,
          agent: req.agent,
          modelSelection: req.modelSelection,
          signal,
          emit: forwardToShadow,
        });
        const result = await this.memory.withContext(memoryContext, () =>
          this.orchestrator.run({
            history: prepared?.history ?? this.conversationStore.toPiMessages(history),
            userMessage: req.message,
            agent: req.agent,
            modelSelection: req.modelSelection,
            context,
            signal,
            emit: forwardToShadow,
            requestApproval: (request) =>
              this.approvals.request(
                { kind: "tool", ...request, conversationId },
                signal,
                (approval) =>
                  forwardToShadow({
                    type: "approval_required",
                    approvalId: approval.id,
                    title: approval.title,
                    detail: approval.detail,
                    risk: approval.risk,
                    payload: approval.payload,
                    reason: approval.reason,
                  }),
              ),
            requestAnswer,
            autoApprove: this.autoApprove,
            mask: this.maskFactory(),
            recordArtifact: shadow
              ? (input) =>
                  this.tasks.recordArtifact({
                    ...input,
                    taskId: shadow.taskId,
                    runId: shadow.runId,
                  })
              : undefined,
            onDelegate: shadow
              ? createDelegateHandler({
                  tasks: this.tasks,
                  evolution: this.evolutionService,
                  approvals: this.approvals,
                  taskId: shadow.taskId,
                  parentRunId: shadow.runId,
                  signal,
                  onAgentEvent: traced,
                })
              : undefined,
          }),
        );
        text = result.text;
        this.insertMessage({
          id: assistantId,
          conversationId,
          role: "assistant",
          content: text,
          agent: result.agent,
          toolCalls: result.toolCalls,
          display: progress.blocks,
          createdAt: nowIso(),
        });
        try {
          await this.memory.withContext(memoryContext, () =>
            this.memory.captureFromTurn({
              userText: req.message,
              assistantText: text,
              conversationId,
              signal,
            }),
          );
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
        const toolCalls = shadow ? readRunToolHistory(this.tasks, shadow.runId) : turnTools.list();
        this.insertMessage({
          id: assistantId,
          conversationId,
          role: "assistant",
          content: runFailureMessage(message, signal.aborted),
          display: [
            ...progress.blocks,
            { kind: "text", text: runFailureMessage(message, signal.aborted) },
          ],
          agent: null,
          toolCalls,
          createdAt: nowIso(),
        });
        if (shadow) {
          try {
            const status = signal.aborted ? "cancelled" : "failed";
            this.tasks.finalizeRunDirect(shadow.runId, { status, resultError: message, toolCalls });
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
      // 清空/删除后不得用内存快照把会话写回。
      const existing = this.conversations.get(conversationId);
      if (existing) {
        this.conversations.put({ ...existing, updatedAt: nowIso() });
      }
      traced({ type: "done", messageId: assistantId });
      return conversationId;
    } finally {
      this.active.delete(conversationId);
      finish();
      release();
    }
  }
}

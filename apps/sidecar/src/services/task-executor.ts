import type {
  ApprovalRequest,
  AutoApprove,
  MaskStore,
  Orchestrator,
  ToolRegistry,
} from "@agentdesk/agent-core";
import type {
  AgentName,
  AgentStreamEvent,
  ArtifactKind,
  Approval,
  Task,
  TaskStreamEvent,
  ToolCallRecord,
} from "@agentdesk/shared";
import { errorMessage, newId, nowIso } from "../util";
import type { ApprovalService } from "./approvals";
import type { ConversationStore } from "./conversation-store";
import type { ConversationContextService } from "./conversation-context";
import { acquireConversation } from "./conversation-activity";
import type { ProjectInstructionService } from "./project-instructions";
import type { MemoryService } from "./memory";
import { formatBehaviorGuidance, type EvolutionService } from "./evolution";
import type { RunExecutor, RunOutcome, TaskService } from "./tasks";
import { readRunToolHistory, summarizeToolCalls } from "./run-tool-history";
import { runFailureMessage, emptyChatProgress, reduceChatProgress } from "@agentdesk/shared";
/**
 * requestAnswer 的通用实现：用 kind='question' 的审批记录承载问题，等待用户通过
 * POST /approvals/:id/answer 回答后，重新查一次这条记录的 payload.answer 拿到回答文本
 * （ApprovalService.request 本身只返回 boolean，answer() 把文本写回了 payload）。
 */
function createRequestAnswer(
  approvals: ApprovalService,
  signal: AbortSignal,
  onCreated: (approval: Approval) => void | Promise<unknown>,
  conversationId?: string,
): (request: ApprovalRequest) => Promise<string> {
  return async (request: ApprovalRequest) => {
    let approvalId = "";
    const approved = await approvals.request(
      { kind: "question", ...request, conversationId },
      signal,
      async (approval) => {
        approvalId = approval.id;
        await onCreated(approval);
      },
    );
    if (!approved) throw new Error("用户未回答该问题（审批被拒绝或已过期）");
    const resolved = (await approvals.list("approved")).find((a) => a.id === approvalId);
    const payload = resolved?.payload as
      | {
          answer?: string;
        }
      | undefined;
    if (!payload?.answer) throw new Error("未获取到用户回答");
    return payload.answer;
  };
}
/**
 * agents.delegate 每次委派都需要的三件事：转发事件、转发审批、落地子 Run 终态。
 * 子 Run 的生命周期单独记录，不向聊天流发送任务级结束事件。
 */
interface DelegateRouting {
  emit: (event: AgentStreamEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  done: (
    result:
      | {
          text: string;
          toolCalls: ToolCallRecord[];
        }
      | {
          error: string;
        },
  ) => void;
}
/**
 * 构造 Orchestrator.run 的 onDelegate 钩子：每次 agents.delegate 调用都会创建一条独立的
 * 子 Run（parentRunId 指向当前 Run），事件写入这条子 Run 自己的 run_events，互不串台。
 * 供真实 executor（任务队列）和 ChatService 的借壳对话共用。
 */
export function createDelegateHandler(deps: {
  tasks: TaskService;
  evolution?: EvolutionService;
  approvals: ApprovalService;
  taskId: string;
  parentRunId: string;
  signal: AbortSignal;
  /** 同步委派时，把子助手进度和审批送回发起请求的聊天界面。 */
  onAgentEvent?: (event: AgentStreamEvent) => void;
}): (info: { agent: AgentName; task: string }) => Promise<DelegateRouting> {
  const { tasks, approvals, taskId, parentRunId, signal } = deps;
  return async ({ agent, task }) => {
    const childRun = await tasks.createRun({
      taskId,
      parentRunId,
      kind: "delegate",
      agent,
      trigger: "delegate",
      input: { userMessage: task },
    });
    deps.evolution?.pin(childRun.id, parentRunId);
    const append = async (event: TaskStreamEvent) =>
      await tasks.appendEvent({ taskId, runId: childRun.id, parentRunId, event });
    const emit = async (event: AgentStreamEvent) => {
      await append(event);
      deps.onAgentEvent?.(event);
    };
    await tasks.startRunDirect(childRun.id);
    const requestApproval = async (request: ApprovalRequest) =>
      await approvals.request(
        {
          kind: "tool",
          ...request,
          conversationId: (await tasks.get(taskId))?.conversationId ?? undefined,
        },
        signal,
        async (approval) =>
          await emit({
            type: "approval_required",
            approvalId: approval.id,
            title: approval.title,
            detail: approval.detail,
            risk: approval.risk,
            payload: approval.payload,
            reason: approval.reason,
          }),
      );
    const done = async (
      result:
        | {
            text: string;
            toolCalls: ToolCallRecord[];
          }
        | {
            error: string;
          },
    ) => {
      const outcome: RunOutcome =
        "error" in result
          ? {
              status: signal.aborted ? "cancelled" : "failed",
              resultError: result.error,
              toolCalls: await readRunToolHistory(tasks, childRun.id),
            }
          : { status: "succeeded", resultText: result.text, toolCalls: result.toolCalls };
      await tasks.finalizeRunDirect(childRun.id, outcome);
      await append({
        type: "run_ended",
        runId: childRun.id,
        status: outcome.status,
        error: outcome.resultError,
      });
    };
    return { emit, requestApproval, done };
  };
}
export interface RealExecutorDeps {
  memory?: MemoryService;
  evolution?: EvolutionService;
  /** TaskService 在构造 executor 闭包之后才完成构造（循环依赖），延迟到真正执行时再取。 */
  getTasks: () => TaskService;
  orchestrator: Orchestrator;
  approvals: ApprovalService;
  conversationStore: ConversationStore;
  context?: ConversationContextService;
  /** 用于在方案关口场景下，把可用工具收紧到"只读工具 + tasks.submit_plan"。 */
  registry: ToolRegistry;
  projectInstructions: ProjectInstructionService;
  autoApprove: AutoApprove;
  maskFactory: () => MaskStore | undefined;
  cloudPolicy?: {
    allowedTools: string[];
    approvalCreated: (approval: Approval, task: Task) => void | Promise<void>;
    requiresPlan: (task: Task) => boolean | Promise<boolean>;
  };
}
/** 阶段 D 的真实 RunExecutor：真正调用 orchestrator，把结果写回会话消息和 run_events。 */
export function createOrchestratorExecutor(deps: RealExecutorDeps): RunExecutor {
  return async (run, task, signal) => {
    // 让出一次微任务：重启恢复时 TaskService 构造函数会同步 pump() 直到调用到这个 executor，
    // 这一行保证外层把 TaskService 自身引用写回 deps 之后，getTasks() 才会被真正调用。
    await Promise.resolve();
    if (task.purpose === "reference_analysis") {
      return {
        status: "failed",
        resultError: "资料分析请从项目中心重新提交，不能通过通用任务继续执行",
      };
    }
    let release: (() => void) | undefined;
    try {
      release = acquireConversation(task.conversationId, "running");
      const tasks = deps.getTasks();
      const { orchestrator, approvals, conversationStore, registry, autoApprove, maskFactory } =
        deps;
      const behavior = deps.evolution?.pin(run.id, run.parentRunId ?? undefined);
      const guidance = behavior ? formatBehaviorGuidance(behavior) : undefined;
      // 方案关口：requiresPlanApproval 的任务首条根 Run 只允许产出方案，不允许执行任何
      // 有副作用的操作——把可用工具收紧到"只读工具 + tasks.submit_plan"，不传给模型
      // agents.delegate 等有副作用能力。真正"未经批准不能执行"的硬校验在 TaskService.createRun
      // 里（服务层），这里只是约束模型这一轮能调用什么。
      const isPlanGate =
        (await deps.cloudPolicy?.requiresPlan(task)) ??
        (task.requiresPlanApproval && run.trigger === "create");
      const allowedTools = deps.cloudPolicy
        ? deps.cloudPolicy.allowedTools.filter(
            (name) =>
              !isPlanGate || name === "tasks.submit_plan" || registry.get(name)?.risk === "safe",
          )
        : isPlanGate
          ? [
              ...registry
                .list()
                .filter((t) => t.risk === "safe")
                .map((t) => t.name),
              "tasks.submit_plan",
            ]
          : undefined;
      const planGateHint = isPlanGate
        ? "本次只需要产出方案并调用 tasks.submit_plan，不要执行任何有副作用的操作。"
        : undefined;
      const planVersionBefore = isPlanGate
        ? ((await tasks.latestArtifact(task.id, "plan"))?.version ?? 0)
        : 0;
      const history = await conversationStore.listMessages(task.conversationId);
      await conversationStore.insertMessage({
        id: newId(),
        conversationId: task.conversationId,
        role: "user",
        content: run.input.userMessage,
        agent: null,
        toolCalls: [],
        createdAt: nowIso(),
      });
      let progress = emptyChatProgress();
      const emit = async (event: TaskStreamEvent) => {
        progress = reduceChatProgress(progress, event);
        return await tasks.appendEvent({
          taskId: task.id,
          runId: run.id,
          parentRunId: run.parentRunId,
          event,
        });
      };
      // 委派子 Run 由 createDelegateHandler 在创建时立即补发 run_started；根 Run 此前没有任何地方
      // 发过这条事件（真实执行只会看到 agent_start/text_delta/agent_end/run_ended），导致 CLI 的
      // task-reducer.mjs（只在收到 run_started 时才建根 Run 节点）在交互式 TaskView 里对根 Run 一直
      // 建不出节点、什么都不渲染——这里补发，让根/子 Run 共用同一条"进入 runsById"的入口事件。
      await emit({
        type: "run_started",
        runId: run.id,
        parentRunId: run.parentRunId,
        agent: run.agent,
        trigger: run.trigger,
      });
      const requestApproval = async (request: ApprovalRequest) =>
        await approvals.request(
          { kind: "tool", ...request, conversationId: task.conversationId ?? undefined },
          signal,
          async (approval) => {
            await deps.cloudPolicy?.approvalCreated(approval, task);
            await emit({
              type: "approval_required",
              approvalId: approval.id,
              title: approval.title,
              detail: approval.detail,
              risk: approval.risk,
              payload: approval.payload,
              reason: approval.reason,
            });
          },
        );
      const requestAnswer = createRequestAnswer(
        approvals,
        signal,
        async (approval) =>
          await emit({
            type: "approval_required",
            approvalId: approval.id,
            title: approval.title,
            detail: approval.detail,
            risk: approval.risk,
            payload: approval.payload,
            reason: approval.reason,
          }),
        task.conversationId ?? undefined,
      );
      const onDelegate = createDelegateHandler({
        tasks,
        evolution: deps.evolution,
        approvals,
        taskId: task.id,
        parentRunId: run.id,
        signal,
      });
      const recordArtifact = async (input: {
        kind: ArtifactKind;
        title: string;
        content?: string;
        metadata?: unknown;
        filePath?: string;
        mimeType?: string;
        artifactKey?: string;
      }) =>
        await tasks.recordArtifact({
          taskId: task.id,
          runId: run.id,
          kind: input.kind,
          title: input.title,
          content: input.content,
          metadata: input.metadata,
          filePath: input.filePath,
          mimeType: input.mimeType,
          artifactKey: input.artifactKey,
        });
      // trigger='resume' 时，把上一条失败/取消的历史 Run 的摘要（工具调用 + 失败原因）
      // 和已有的 plan 产物（阶段 F 才会真正产出，这里查不到时直接跳过）拼进这次的 context，
      // 让模型知道"之前已经做过什么、为什么失败"，而不是从零开始。
      let resumeContext: string | undefined;
      if (run.trigger === "resume") {
        const previousFailed = (await tasks.listRuns(task.id))
          .filter((r) => r.id !== run.id && (r.status === "failed" || r.status === "cancelled"))
          .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0];
        const parts: string[] = [];
        if (previousFailed) {
          const toolCalls = previousFailed.toolCalls?.length
            ? (previousFailed.toolCalls as ToolCallRecord[])
            : await readRunToolHistory(tasks, previousFailed.id);
          if (toolCalls.length > 0) {
            parts.push(
              `之前已记录以下操作，请跳过已确认完成的操作：${summarizeToolCalls(toolCalls)}`,
            );
          }
          if (previousFailed.resultError) parts.push(`上次失败原因：${previousFailed.resultError}`);
        }
        const plan = await tasks.latestArtifact(task.id, "plan");
        if (plan) {
          parts.push(
            `已有方案草稿（版本 ${plan.version}）：${(plan.content ?? plan.title).slice(0, 1000)}`,
          );
        }
        if (parts.length > 0) resumeContext = parts.join("\n");
      }
      try {
        const projectContext = await deps.projectInstructions.load(run.input.workspace, signal);
        const memoryContext = {
          workspace: run.input.workspace,
          conversationId: task.conversationId ?? undefined,
        };
        const recalled = deps.memory?.withContext(memoryContext, () =>
          deps.memory!.formatForPrompt(deps.memory!.recall(run.input.userMessage)),
        );
        const context =
          [run.input.context, resumeContext, projectContext, planGateHint, recalled, guidance]
            .filter(Boolean)
            .join("\n\n") || undefined;
        const prepared = await deps.context?.prepare({
          conversationId: task.conversationId,
          history,
          userMessage: run.input.userMessage,
          systemContext: context,
          agent: run.agent,
          signal,
          emit,
        });
        const execute = () =>
          orchestrator.run({
            history: prepared?.history ?? conversationStore.toPiMessages(history),
            userMessage: run.input.userMessage,
            agent: run.agent,
            context,
            signal,
            emit,
            requestApproval,
            requestAnswer,
            onDelegate,
            allowedTools,
            recordArtifact,
            autoApprove,
            mask: maskFactory(),
          });
        const result = await (deps.memory
          ? deps.memory.withContext(memoryContext, execute)
          : execute());
        await conversationStore.insertMessage({
          id: newId(),
          conversationId: task.conversationId,
          role: "assistant",
          content: result.text,
          display: progress.blocks,
          agent: result.agent,
          toolCalls: result.toolCalls,
          createdAt: nowIso(),
        });
        if (!isPlanGate && deps.memory) {
          await deps.memory.withContext(
            memoryContext,
            async () =>
              await deps.memory!.captureFromTurn({
                userText: run.input.userMessage,
                assistantText: result.text,
                conversationId: task.conversationId,
                signal,
              }),
          );
        }
        await emit({ type: "run_ended", runId: run.id, status: "succeeded" });
        if (isPlanGate) {
          const plan = await tasks.latestArtifact(task.id, "plan");
          if (plan && plan.version > planVersionBefore) {
            // 不 await：这条 Run 在方案提交后就算成功结束，批准/拒绝由下面的 .then()
            // 异步驱动 Task 的后续状态迁移（awaiting_plan_approval -> running/planning）。
            void approvals
              .request(
                {
                  kind: "plan",
                  title: `方案待批准：${task.title}`,
                  detail: plan.content ?? plan.title,
                  risk: "confirm",
                  payload: { taskId: task.id, artifactId: plan.id, version: plan.version },
                },
                signal,
                async (approval) => {
                  await deps.cloudPolicy?.approvalCreated(approval, task);
                  await emit({
                    type: "approval_required",
                    approvalId: approval.id,
                    title: approval.title,
                    detail: approval.detail,
                    risk: approval.risk,
                    payload: approval.payload,
                    reason: approval.reason,
                  });
                },
              )
              .then(async (approved) => {
                try {
                  await tasks.transition(task.id, approved ? "running" : "planning");
                } catch {
                  // 任务状态机已经走到其它分支（例如被用户取消），忽略
                }
              });
            return {
              status: "succeeded",
              resultText: result.text,
              toolCalls: result.toolCalls,
              nextTaskStatus: "awaiting_plan_approval",
            };
          }
          if (deps.cloudPolicy) throw new Error("The remote planning run did not submit a plan");
          console.error(
            `[task-executor] 方案关口：模型未调用 tasks.submit_plan，已降级为直接执行（taskId=${task.id} runId=${run.id}）`,
          );
        }
        // 正常走到 awaiting_review：真正创建一条 kind='review' 的审批记录承载验收，而不是等
        // POST /tasks/:id/review 被调用时凭空接受一个请求。只对 requiresPlanApproval 的任务
        // 主动创建——这类任务本来就走正式的流程监管（方案关口 + 验收关口成对出现）；普通任务
        // （例如既有的 /chat 借壳、ask_user 追问等场景）不主动创建，避免给每一次任务完成都挂一条
        // 永不过期的 pending 审批，污染"取第一条 pending 审批"这类既有调用方的假设。没有主动创建
        // 的任务仍可以正常走 POST /tasks/:id/review——那里有懒创建兜底，同样会落一条真实记录。
        if (task.requiresPlanApproval) {
          const review = (
            await approvals.create({
              kind: "review",
              title: `验收：${task.title}`,
              detail: result.text.slice(0, 2000),
              risk: "confirm",
              payload: { taskId: task.id, runId: run.id },
            })
          ).approval;
          deps.cloudPolicy?.approvalCreated(review, task);
        }
        return { status: "succeeded", resultText: result.text, toolCalls: result.toolCalls };
      } catch (error) {
        const status = signal.aborted ? "cancelled" : "failed";
        const message = errorMessage(error);
        const toolCalls = await readRunToolHistory(tasks, run.id);
        await conversationStore.insertMessage({
          id: newId(),
          conversationId: task.conversationId,
          role: "assistant",
          content: runFailureMessage(message, signal.aborted),
          display: [
            ...progress.blocks,
            { kind: "text", text: runFailureMessage(message, signal.aborted) },
          ],
          agent: run.agent,
          toolCalls,
          createdAt: nowIso(),
        });
        await emit({ type: "run_ended", runId: run.id, status, error: message });
        return { status, resultError: message, toolCalls };
      }
    } catch (error) {
      return { status: signal.aborted ? "cancelled" : "failed", resultError: errorMessage(error) };
    } finally {
      release?.();
    }
  };
}

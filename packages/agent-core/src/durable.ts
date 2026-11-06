import { createHash } from "node:crypto";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentName, ToolCallRecord } from "@agentdesk/shared";
import type { AgentRunResult, RunAgentOptions } from "./agent";
import type { ApprovalRequest } from "./tools";

export const DURABLE_EXECUTOR_VERSION = "agentdesk-agent-v1";

export interface DurableSuspension {
  id: string;
  kind: "input" | "authorization";
  toolCallId: string;
  toolName: string;
  request: ApprovalRequest;
  requestHash: string;
}

export type AgentExecutionOutcome =
  { status: "completed" } | { status: "suspended"; suspension: DurableSuspension };

interface DurableDecision {
  kind: DurableSuspension["kind"];
  request: ApprovalRequest;
  requestHash: string;
  value: string | boolean;
}

export interface DurableStep {
  id: string;
  inputHash: string;
  toolName: string;
  status: "prepared" | "started" | "completed" | "unknown";
  decisions: Record<string, DurableDecision>;
  record?: ToolCallRecord;
  result?: ToolResultMessage;
}

/** 仅保存在后端，包含模型历史和具体操作参数，不能作为前端 DTO。 */
export interface DurableCheckpoint {
  schemaVersion: 1;
  executorVersion: typeof DURABLE_EXECUTOR_VERSION;
  revision: number;
  agent: AgentName;
  phase: "model" | "tools" | "suspended" | "completed" | "unknown";
  turn: number;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  pendingCalls: ToolCall[];
  nextToolIndex: number;
  steps: Record<string, DurableStep>;
  allowedTools: string[] | null;
  text: string;
  providerId: string | null;
  suspension?: DurableSuspension;
}

export interface DurableAgentOptions {
  checkpoint?: DurableCheckpoint;
  /** 宿主必须事务比较 revision、执行 epoch 和取消状态；拒绝保存时立即停止执行。 */
  save: (checkpoint: DurableCheckpoint) => void | Promise<void>;
  resume?: { interactionId: string; value: string | boolean };
  /** 已批准操作执行前重新校验资源与权限；抛错会阻止该操作。 */
  validateApproval?: (request: ApprovalRequest) => void | Promise<void>;
}

export class DurableExecutionUnknownError extends Error {
  constructor(readonly stepId: string) {
    super("操作执行结果需要核实，不能自动重新执行");
    this.name = "DurableExecutionUnknownError";
  }
}

export class DurableCheckpointError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableCheckpointError";
  }
}

/** 已确认停在模型请求边界，宿主可按错误类型决定是否退避重试。 */
export class DurableModelError extends Error {
  constructor(cause: unknown) {
    super("模型请求未完成，执行检查点已保留", { cause });
    this.name = "DurableModelError";
  }
}

/** 内部控制流必须贯穿工具 catch；它不是可提交给模型的普通工具错误。 */
export class DurableSuspensionSignal extends Error {
  constructor(readonly suspension: DurableSuspension) {
    super("Agent execution suspended");
    this.name = "DurableSuspensionSignal";
  }
}

export interface DurableToolExecution {
  beforeExecute: () => Promise<void>;
  onExecutionError: () => Promise<never>;
}

interface DurableRunner {
  model: (messages: Message[]) => Promise<{ message: AssistantMessage; providerId: string }>;
  tool: (
    call: ToolCall,
    options: RunAgentOptions,
    access: { allowed: Set<string> | null },
    execution: DurableToolExecution,
  ) => Promise<{ record: ToolCallRecord; result: ToolResultMessage }>;
}

/** 对象键顺序不参与动作身份，恢复时参数内容变化必须拒绝重放。 */
function fingerprint(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export async function runDurableAgent(
  options: RunAgentOptions,
  runner: DurableRunner,
): Promise<AgentRunResult> {
  const durable = options.durable!;
  const checkpoint: DurableCheckpoint = durable.checkpoint
    ? structuredClone(durable.checkpoint)
    : {
        schemaVersion: 1,
        executorVersion: DURABLE_EXECUTOR_VERSION,
        revision: 0,
        agent: options.definition.name,
        phase: "model",
        turn: 0,
        messages: structuredClone(options.messages),
        toolCalls: [],
        pendingCalls: [],
        nextToolIndex: 0,
        steps: {},
        allowedTools: null,
        text: "",
        providerId: null,
      };
  if (checkpoint.schemaVersion !== 1 || checkpoint.executorVersion !== DURABLE_EXECUTOR_VERSION)
    throw new DurableCheckpointError("执行器版本不兼容，不能自动恢复该检查点");
  if (checkpoint.agent !== options.definition.name)
    throw new DurableCheckpointError("恢复时不能更换执行 Agent");

  const persist = async () => {
    options.signal?.throwIfAborted();
    checkpoint.revision++;
    try {
      await durable.save(structuredClone(checkpoint));
    } catch (cause) {
      throw new DurableCheckpointError("无法保存执行检查点，已停止推进", { cause });
    }
    options.signal?.throwIfAborted();
  };
  const result = (outcome: AgentExecutionOutcome): AgentRunResult => ({
    ...outcome,
    text: checkpoint.text,
    toolCalls: checkpoint.toolCalls,
    messages: checkpoint.messages,
    providerId: checkpoint.providerId,
  });
  const markUnknown = async (step: DurableStep): Promise<never> => {
    step.status = "unknown";
    checkpoint.phase = "unknown";
    await persist();
    throw new DurableExecutionUnknownError(step.id);
  };
  if (checkpoint.phase === "unknown")
    throw new DurableExecutionUnknownError(
      Object.values(checkpoint.steps).find((step) => step.status === "unknown")?.id ?? "unknown",
    );
  if (checkpoint.phase === "completed") {
    if (durable.resume) throw new DurableCheckpointError("该执行已完成，不能重复消费回答");
    return result({ status: "completed" });
  }
  if (checkpoint.phase === "suspended") {
    const suspension = checkpoint.suspension;
    if (!suspension) throw new DurableCheckpointError("检查点缺少待处理问题");
    if (!durable.resume) return result({ status: "suspended", suspension });
    if (durable.resume.interactionId !== suspension.id)
      throw new DurableCheckpointError("回答不属于当前待处理问题");
    if (typeof durable.resume.value !== (suspension.kind === "input" ? "string" : "boolean"))
      throw new DurableCheckpointError("回答类型与待处理问题不匹配");
    const step = checkpoint.steps[suspension.toolCallId];
    if (!step || step.status !== "prepared")
      throw new DurableCheckpointError("待恢复工具的执行位置无效");
    step.decisions[suspension.id] = {
      kind: suspension.kind,
      request: suspension.request,
      requestHash: suspension.requestHash,
      value: durable.resume.value,
    };
    delete checkpoint.suspension;
    checkpoint.phase = "tools";
    await persist();
  } else if (durable.resume) {
    throw new DurableCheckpointError("该回答已经消费或当前没有待处理问题");
  }

  const access = { allowed: checkpoint.allowedTools ? new Set(checkpoint.allowedTools) : null };
  options.emit({ type: "agent_start", agent: options.definition.name });
  if (!durable.checkpoint) await persist();
  const maxTurns = options.definition.maxTurns ?? 12;
  while (true) {
    options.signal?.throwIfAborted();
    if (checkpoint.phase === "model") {
      if (checkpoint.turn >= maxTurns)
        throw new DurableCheckpointError(`Agent 已达到 ${maxTurns} 轮执行上限，执行记录已保留`);
      options.emit({ type: "response_start", agent: options.definition.name });
      let generated: Awaited<ReturnType<DurableRunner["model"]>>;
      try {
        generated = await runner.model(checkpoint.messages);
      } catch (cause) {
        throw new DurableModelError(cause);
      }
      const { message, providerId } = generated;
      checkpoint.messages.push(message);
      checkpoint.providerId = providerId;
      checkpoint.text = assistantText(message);
      checkpoint.turn++;
      checkpoint.pendingCalls = message.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );
      checkpoint.nextToolIndex = 0;
      checkpoint.phase =
        message.stopReason === "toolUse" && checkpoint.pendingCalls.length > 0
          ? "tools"
          : "completed";
      // 模型完成结果与工具调用列表必须先保存，恢复时才能使用同一组调用 ID。
      await persist();
      if (checkpoint.phase === "completed") break;
    }

    for (; checkpoint.nextToolIndex < checkpoint.pendingCalls.length;) {
      const call = checkpoint.pendingCalls[checkpoint.nextToolIndex]!;
      const inputHash = fingerprint({ name: call.name, args: call.arguments });
      let step = checkpoint.steps[call.id];
      if (step && step.inputHash !== inputHash)
        throw new DurableCheckpointError("工具调用 ID 对应的参数已经变化");
      if (!step) {
        step = {
          id: call.id,
          inputHash,
          toolName: call.name.replace(/__/g, "."),
          status: "prepared",
          decisions: {},
        };
        checkpoint.steps[call.id] = step;
        await persist();
      }
      if (step.status === "started" || step.status === "unknown") await markUnknown(step);
      let completed: { record: ToolCallRecord; result: ToolResultMessage };
      if (step.status === "completed") {
        if (!step.record || !step.result)
          throw new DurableCheckpointError("已完成步骤缺少保存的结果");
        completed = { record: step.record, result: step.result };
      } else {
        const currentStep = step;
        const tool = options.tools.find((candidate) => candidate.name === currentStep.toolName);
        const validateDecision = async (request: ApprovalRequest) => {
          if (!durable.validateApproval)
            throw new DurableCheckpointError("恢复授权操作前必须校验当前资源与权限");
          try {
            await durable.validateApproval(request);
          } catch (cause) {
            throw new DurableCheckpointError("授权操作的资源或权限校验失败，已停止执行", { cause });
          }
        };
        let validatedApproval = false;
        let interactionIndex = 0;
        const decide = async (
          kind: DurableSuspension["kind"],
          request: ApprovalRequest,
        ): Promise<string | boolean> => {
          // 普通工具执行到一半再询问不能安全重放；只有声明纯交互的工具允许这样挂起。
          if (currentStep.status === "started") return markUnknown(currentStep);
          const id = `${call.id}:${kind}:${interactionIndex++}`;
          const requestHash = fingerprint({
            title: request.title,
            detail: request.detail,
            risk: request.risk,
            payload: request.payload,
          });
          const decision = currentStep.decisions[id];
          if (decision?.requestHash === requestHash) {
            if (kind === "authorization" && decision.value === true) {
              await validateDecision(request);
              validatedApproval = true;
            }
            return decision.value;
          }
          const suspension: DurableSuspension = {
            id,
            kind,
            toolCallId: call.id,
            toolName: currentStep.toolName,
            request,
            requestHash,
          };
          throw new DurableSuspensionSignal(suspension);
        };
        try {
          completed = await runner.tool(
            call,
            {
              ...options,
              // 用户已作出的拒绝不能因新规则自动放行而被覆盖；批准仍须走重新校验。
              autoApprove: Object.keys(currentStep.decisions).some((key) =>
                key.includes(":authorization:"),
              )
                ? async () => ({ approved: false })
                : options.autoApprove,
              requestApproval: (request) => decide("authorization", request) as Promise<boolean>,
              requestAnswer: (request) => decide("input", request) as Promise<string>,
            },
            access,
            {
              beforeExecute: async () => {
                for (const decision of Object.values(currentStep.decisions)) {
                  if (decision.kind !== "authorization") continue;
                  if (decision.value !== true) throw new Error("用户拒绝了该操作");
                  if (!validatedApproval) await validateDecision(decision.request);
                }
                if (tool?.interactionOnly === true && tool.risk === "safe") return;
                currentStep.status = "started";
                await persist();
              },
              onExecutionError: () => markUnknown(currentStep),
            },
          );
        } catch (error) {
          if (!(error instanceof DurableSuspensionSignal)) throw error;
          checkpoint.phase = "suspended";
          checkpoint.suspension = error.suspension;
          await persist();
          return result({ status: "suspended", suspension: error.suspension });
        }
      }
      step.status = "completed";
      step.record = completed.record;
      step.result = completed.result;
      checkpoint.toolCalls.push(completed.record);
      checkpoint.messages.push(completed.result);
      checkpoint.nextToolIndex++;
      checkpoint.allowedTools = access.allowed ? [...access.allowed] : null;
      await persist();
      options.emit({
        type: "tool_result",
        agent: options.definition.name,
        id: call.id,
        result: completed.record.result,
        isError: completed.record.isError === true,
      });
    }
    checkpoint.phase = "model";
    checkpoint.pendingCalls = [];
    checkpoint.nextToolIndex = 0;
    await persist();
  }
  options.emit({ type: "agent_end", agent: options.definition.name });
  return result({ status: "completed" });
}

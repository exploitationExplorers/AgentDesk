import {
  stream,
  validateToolArguments,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { AgentName, AgentStreamEvent, ToolCallRecord } from "@agentdesk/shared";
import type { ResolvedModel } from "./llm";
import { DEFAULT_CONTEXT_WINDOW } from "./llm";
import { estimateMessageTokens, estimateTokens, inputBudget } from "./context";
import { createStreamUnmasker, maskJson, maskText, unmaskJson, type MaskStore } from "./masking";
import {
  fromWireName,
  toPiTool,
  type AnyAgentTool,
  type ApprovalRequest,
  type AutoApprove,
  type RecordArtifactInput,
  type RecordedArtifact,
  type ToolContext,
} from "./tools";

export interface AgentDefinition {
  name: AgentName;
  title: string;
  description: string;
  systemPrompt: string;
  /** ToolRegistry.select 的匹配模式 */
  tools: string[];
  maxTurns?: number;
}

export interface RunAgentOptions {
  definition: AgentDefinition;
  tools: AnyAgentTool[];
  models: ResolvedModel[];
  messages: Message[];
  systemPromptSuffix?: string;
  emit: (event: AgentStreamEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  requestAnswer?: (request: ApprovalRequest) => Promise<string>;
  recordArtifact?: (input: RecordArtifactInput) => RecordedArtifact;
  /** 可选：审批前先问一次能不能自动放行（规则匹配/分类器等）。不传时行为与现状完全一致。 */
  autoApprove?: AutoApprove;
  /** 可选：发给模型前脱敏、拿到回复后换回真实值。同一次对话/任务的多轮、多委派 Agent 共用同一个 store。 */
  mask?: MaskStore;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  toolCalls: ToolCallRecord[];
  messages: Message[];
  providerId: string | null;
}

export class NoModelError extends Error {
  constructor(agent: AgentName) {
    super(`没有可用的模型：请先在 设置 > Provider 中为 ${agent} 配置模型`);
    this.name = "NoModelError";
  }
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 24_000 ? `${json.slice(0, 24_000)}\n...(truncated)` : json;
  } catch {
    return String(value);
  }
}

/**
 * 单次模型调用，支持备用模型切换：只有在尚未产生任何输出时才切换，
 * 避免同一轮回答被两个模型拼接。
 */
/** 单次模型请求上限，避免中转站不可达时 Bot 一直转圈 */
const MODEL_CALL_TIMEOUT_MS = 90_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function callModel(
  models: ResolvedModel[],
  context: Parameters<typeof stream>[1],
  agent: AgentName,
  emit: RunAgentOptions["emit"],
  signal?: AbortSignal,
  mask?: MaskStore,
): Promise<{ message: AssistantMessage; providerId: string }> {
  const outboundContext = mask
    ? {
        ...context,
        systemPrompt: context.systemPrompt
          ? maskText(context.systemPrompt, mask)
          : context.systemPrompt,
        messages: maskJson(context.messages, mask),
      }
    : context;
  let lastError = "unknown error";
  for (const candidate of models) {
    const contextWindow = candidate.model.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const estimatedInputTokens =
      estimateMessageTokens(outboundContext.messages) +
      estimateTokens(outboundContext.systemPrompt ?? "") +
      estimateTokens(JSON.stringify(outboundContext.tools ?? []));
    if (estimatedInputTokens > inputBudget(contextWindow, candidate.model.maxTokens || 4096)) {
      lastError = `上下文超出 ${candidate.model.id} 的输入预算（估算 ${estimatedInputTokens} tokens）。请压缩历史、缩短输入或扩大模型窗口后继续；执行记录已保留。`;
      continue;
    }
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      let produced = false;
      const callSignal = withTimeout(signal, MODEL_CALL_TIMEOUT_MS);
      const events = stream(candidate.model, outboundContext, {
        apiKey: candidate.apiKey,
        signal: callSignal,
        maxTokens: candidate.model.maxTokens,
      });
      // 占位符可能被流式输出切断在两个 delta 之间，缓冲到确认安全（不是未闭合的占位符前缀）再展示。
      const unmasker = mask ? createStreamUnmasker(mask) : null;
      for await (const event of events) {
        if (event.type === "text_delta") {
          produced = true;
          const delta = unmasker ? unmasker.push(event.delta) : event.delta;
          if (delta) emit({ type: "text_delta", agent, delta });
        } else if (event.type === "toolcall_start") {
          produced = true;
        }
      }
      if (unmasker) {
        const rest = unmasker.flush();
        if (rest) emit({ type: "text_delta", agent, delta: rest });
      }
      const message = await events.result();
      if (message.stopReason === "aborted") {
        if (signal?.aborted) throw new Error("已取消");
        lastError =
          "请求超时：请检查 设置 → 通用 → HTTP 代理（Claude Code 能通时通常需要填写 Clash 等本地代理，如 http://127.0.0.1:7890）";
        break;
      }
      if (message.stopReason !== "error") {
        // 用量来自供应商响应；估算仅用于预算，不作为实际计费数据。
        emit({
          type: "model_usage",
          purpose: "response",
          agent,
          providerId: candidate.providerId,
          model: candidate.model.id,
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          totalTokens: message.usage.totalTokens,
          contextWindow,
          estimatedInputTokens,
        });
        // 整体反脱敏（含 ToolCall.arguments，覆盖模型原样复读占位符到工具调用参数的情况），
        // 这个返回值会被 runAgent 推入对话历史、也会被 executeToolCall 直接拿去真正执行工具。
        return {
          message: mask ? unmaskJson(message, mask) : message,
          providerId: candidate.providerId,
        };
      }
      lastError = message.errorMessage ?? lastError;
      if (produced) throw new Error(`模型调用失败：${lastError}`);
      if (!isTransient(lastError) || attempt === TRANSIENT_RETRIES) break;
      await sleep(1000 * 2 ** attempt, signal);
    }
  }
  throw new Error(`模型调用失败：${lastError}`);
}

const TRANSIENT_RETRIES = 2;
const MAX_CONCURRENT_TOOLS = 8;

/** 中转站常见的瞬时错误：过载、限流、网关超时等，值得原样重试 */
export function isTransient(message: string): boolean {
  return /overload|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b|timeout|timed out|ECONNRESET|socket hang up|try again|retry your request|server_error|fetch failed/i.test(
    message,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("已取消"));
      },
      { once: true },
    );
  });
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { definition, tools, models, emit, signal } = options;
  if (models.length === 0) throw new NoModelError(definition.name);

  const messages: Message[] = [...options.messages];
  const toolCalls: ToolCallRecord[] = [];
  const piTools = tools.map(toPiTool);
  const systemPrompt = [definition.systemPrompt, options.systemPromptSuffix]
    .filter(Boolean)
    .join("\n\n");
  const maxTurns = definition.maxTurns ?? 12;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1)
    throw new Error("Agent 的 maxTurns 必须是正整数");
  let finalText = "";
  let providerId: string | null = null;

  emit({ type: "agent_start", agent: definition.name });
  // 本次运行当前允许调用的工具；null 表示不限制，加载了声明 allowed-tools 的技能后收紧（并集）。
  const access: ToolAccessState = { allowed: null };

  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    const { message, providerId: used } = await callModel(
      models,
      { systemPrompt, messages, tools: piTools.length > 0 ? piTools : undefined },
      definition.name,
      emit,
      signal,
      options.mask,
    );
    providerId = used;
    messages.push(message);
    finalText = textOf(message);

    const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
    if (message.stopReason !== "toolUse" || calls.length === 0) break;

    for (const batch of toolCallBatches(calls, tools)) {
      signal?.throwIfAborted();
      // 即使事件回调或其他外围逻辑抛错，也等本批已启动的工具全部收尾，避免悬空操作。
      const settled = await Promise.allSettled(
        batch.map((call) =>
          executeToolCall(call, tools, piTools, options, definition.name, access),
        ),
      );
      signal?.throwIfAborted();
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
        toolCalls.push(outcome.value.record);
        messages.push(outcome.value.result);
      }
    }
    if (turn === maxTurns - 1) {
      throw new Error(
        `Agent 已达到 ${maxTurns} 轮执行上限，仍需继续处理工具结果，任务尚未完成。已执行的操作记录已保留，可检查后继续运行。`,
      );
    }
  }

  emit({ type: "agent_end", agent: definition.name });
  return { text: finalText, toolCalls, messages, providerId };
}

/** 连续只读调用可并发，写入及未知工具形成屏障，不允许后面的读取越过写入。 */
function* toolCallBatches(calls: ToolCall[], tools: AnyAgentTool[]): Generator<ToolCall[]> {
  let reads: ToolCall[] = [];
  for (const call of calls) {
    const tool = tools.find((candidate) => candidate.name === fromWireName(call.name));
    if (tool?.isConcurrencySafe === true) {
      reads.push(call);
      if (reads.length === MAX_CONCURRENT_TOOLS) {
        yield reads;
        reads = [];
      }
      continue;
    }
    if (reads.length > 0) {
      yield reads;
      reads = [];
    }
    yield [call];
  }
  if (reads.length > 0) yield reads;
}

/** 本次 Agent 运行当前被允许调用的工具集合；null 表示不限制。 */
interface ToolAccessState {
  allowed: Set<string> | null;
}

async function executeToolCall(
  call: ToolCall,
  tools: AnyAgentTool[],
  piTools: ReturnType<typeof toPiTool>[],
  options: RunAgentOptions,
  agent: AgentName,
  access: ToolAccessState,
): Promise<{ record: ToolCallRecord; result: ToolResultMessage }> {
  const name = fromWireName(call.name);
  const tool = tools.find((t) => t.name === name);
  options.emit({ type: "tool_call", agent, id: call.id, name, args: call.arguments });

  let output: unknown;
  let isError = false;
  try {
    options.signal?.throwIfAborted();
    if (!tool) throw new Error(`未知工具：${name}`);
    // 能调整收紧状态的工具（如 skills.load）永远不受限，否则一旦收紧就再也调不回来。
    if (access.allowed && !access.allowed.has(name) && !tool.restrictsToolsTo) {
      throw new Error(
        `当前已激活的技能把可用工具收紧为：${[...access.allowed].join(", ")}；` +
          `${name} 不在其中。如需使用，请先加载声明了该工具权限的技能。`,
      );
    }
    const piTool = piTools.find((t) => t.name === call.name);
    const args = piTool ? validateToolArguments(piTool, call) : call.arguments;

    const risk = tool.riskFor?.(args) ?? tool.risk;
    if (risk !== "safe") {
      // autoApprove 失败时必须等价于 { approved: false }，不能让规则/分类器故障导致误放行。
      const auto = (await options.autoApprove?.(name, args, risk).catch(() => undefined)) ?? {
        approved: false as const,
      };
      if (auto.approved) {
        options.emit({
          type: "auto_approved",
          agent,
          id: call.id,
          name,
          reason: auto.reason,
          source: auto.source,
        });
      } else {
        const described = (await tool.describeApproval?.(args)) ?? {
          title: `执行 ${name}`,
          detail: JSON.stringify(args, null, 2),
        };
        const approved = await options.requestApproval({
          ...described,
          risk,
          payload: { tool: name, args },
          reason: auto.note
            ? { type: "classifier_declined", note: auto.note }
            : { type: "default" },
        });
        if (!approved) throw new Error("用户拒绝了该操作");
      }
    }

    const ctx: ToolContext = {
      agent,
      toolCallId: call.id,
      signal: options.signal,
      emit: options.emit,
      requestApproval: options.requestApproval,
      requestAnswer: options.requestAnswer,
      recordArtifact: options.recordArtifact,
    };
    options.signal?.throwIfAborted();
    output = await tool.execute(args, ctx);
    const widen = tool.restrictsToolsTo?.(output);
    if (widen && widen.length > 0) {
      access.allowed = new Set([...(access.allowed ?? []), ...widen]);
    }
  } catch (error) {
    isError = true;
    output = error instanceof Error ? error.message : String(error);
  }

  options.emit({ type: "tool_result", agent, id: call.id, result: output, isError });
  return {
    record: { id: call.id, name, args: call.arguments, result: output, isError, agent },
    result: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: stringifyResult(output) }],
      isError,
      timestamp: Date.now(),
    },
  };
}

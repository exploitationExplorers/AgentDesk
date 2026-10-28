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
import {
  fromWireName,
  toPiTool,
  type AnyAgentTool,
  type ApprovalRequest,
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
): Promise<{ message: AssistantMessage; providerId: string }> {
  let lastError = "unknown error";
  for (const candidate of models) {
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      let produced = false;
      const callSignal = withTimeout(signal, MODEL_CALL_TIMEOUT_MS);
      const events = stream(candidate.model, context, {
        apiKey: candidate.apiKey,
        signal: callSignal,
      });
      for await (const event of events) {
        if (event.type === "text_delta") {
          produced = true;
          emit({ type: "text_delta", agent, delta: event.delta });
        } else if (event.type === "toolcall_start") {
          produced = true;
        }
      }
      const message = await events.result();
      if (message.stopReason === "aborted") {
        if (signal?.aborted) throw new Error("已取消");
        lastError =
          "请求超时：请检查 设置 → 通用 → HTTP 代理（Claude Code 能通时通常需要填写 Clash 等本地代理，如 http://127.0.0.1:7890）";
        break;
      }
      if (message.stopReason !== "error") return { message, providerId: candidate.providerId };
      lastError = message.errorMessage ?? lastError;
      if (produced) throw new Error(`模型调用失败：${lastError}`);
      if (!isTransient(lastError) || attempt === TRANSIENT_RETRIES) break;
      await sleep(1000 * 2 ** attempt, signal);
    }
  }
  throw new Error(`模型调用失败：${lastError}`);
}

const TRANSIENT_RETRIES = 2;

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
  let finalText = "";
  let providerId: string | null = null;

  emit({ type: "agent_start", agent: definition.name });

  for (let turn = 0; turn < maxTurns; turn++) {
    const { message, providerId: used } = await callModel(
      models,
      { systemPrompt, messages, tools: piTools.length > 0 ? piTools : undefined },
      definition.name,
      emit,
      signal,
    );
    providerId = used;
    messages.push(message);
    finalText = textOf(message);

    const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
    if (message.stopReason !== "toolUse" || calls.length === 0) break;

    const results = await Promise.all(
      calls.map((call) => executeToolCall(call, tools, piTools, options, definition.name)),
    );
    for (const { record, result } of results) {
      toolCalls.push(record);
      messages.push(result);
    }
  }

  emit({ type: "agent_end", agent: definition.name });
  return { text: finalText, toolCalls, messages, providerId };
}

async function executeToolCall(
  call: ToolCall,
  tools: AnyAgentTool[],
  piTools: ReturnType<typeof toPiTool>[],
  options: RunAgentOptions,
  agent: AgentName,
): Promise<{ record: ToolCallRecord; result: ToolResultMessage }> {
  const name = fromWireName(call.name);
  const tool = tools.find((t) => t.name === name);
  options.emit({ type: "tool_call", agent, id: call.id, name, args: call.arguments });

  let output: unknown;
  let isError = false;
  try {
    if (!tool) throw new Error(`未知工具：${name}`);
    const piTool = piTools.find((t) => t.name === call.name);
    const args = piTool ? validateToolArguments(piTool, call) : call.arguments;

    const risk = tool.riskFor?.(args) ?? tool.risk;
    if (risk !== "safe") {
      const described = tool.describeApproval?.(args) ?? {
        title: `执行 ${name}`,
        detail: JSON.stringify(args, null, 2),
      };
      const approved = await options.requestApproval({
        ...described,
        risk,
        payload: { tool: name, args },
      });
      if (!approved) throw new Error("用户拒绝了该操作");
    }

    const ctx: ToolContext = {
      agent,
      signal: options.signal,
      emit: options.emit,
      requestApproval: options.requestApproval,
      requestAnswer: options.requestAnswer,
      recordArtifact: options.recordArtifact,
    };
    output = await tool.execute(args, ctx);
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

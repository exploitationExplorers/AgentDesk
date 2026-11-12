import type { Static, TSchema, Tool } from "@mariozechner/pi-ai";
import type {
  AgentName,
  AgentStreamEvent,
  ApprovalReason,
  ArtifactKind,
  RiskLevel,
} from "@agentdesk/shared";

export interface ApprovalRequest {
  title: string;
  detail: string;
  risk: RiskLevel;
  payload: unknown;
  reason?: ApprovalReason;
}

/**
 * 审批前先问一次能不能自动放行（命中已保存的规则 / 分类器判定安全等）。
 * `approved: false` 覆盖"没有规则可查"和"分类器明确判定仍需确认"两种情况，
 * 调用失败时必须等价于 `{ approved: false }`，绝不能默认放行。
 */
export type AutoApprove = (
  tool: string,
  args: unknown,
  risk: RiskLevel,
) => Promise<
  | { approved: true; reason: string; source: "rule" | "classifier" }
  | { approved: false; note?: string }
>;

export interface RecordArtifactInput {
  kind: ArtifactKind;
  title: string;
  content?: string;
  filePath?: string;
  mimeType?: string;
  artifactKey?: string;
  metadata?: unknown;
}

export interface RecordedArtifact {
  id: string;
  version: number;
}

/** 由宿主限定到当前 Task，并在每次写入时校验执行权；不得传入全局状态仓库。 */
export interface DurableToolState {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

export interface ToolContext {
  agent: AgentName;
  toolCallId?: string;
  signal?: AbortSignal;
  emit: (event: AgentStreamEvent) => void;
  /** 返回 true 表示用户批准。 */
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * 可选：向用户追问并拿到回答文本的能力。只在支持追问的执行上下文（Task 根 Run、
   * /chat 借壳任务）中提供；委派给子 Agent 的上下文不提供，工具需要自行判断缺失时报错。
   */
  requestAnswer?: (request: ApprovalRequest) => Promise<string>;
  /**
   * 可选：记录一份任务产物（方案/变更/测试结果等），落库由调用方（TaskService）实现。
   * 只在方案关口等支持产物持久化的执行上下文中提供，例如 tasks.submit_plan 工具。
   */
  recordArtifact?: (input: RecordArtifactInput) => RecordedArtifact | Promise<RecordedArtifact>;
  durableState?: DurableToolState;
}

export interface AgentTool<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  /** safe 直接执行；confirm/dangerous 需要人工审批。 */
  risk: RiskLevel;
  /** 按参数动态判定风险，例如白名单内的只读命令可以免审批 */
  riskFor?: (args: Static<TParams>) => RiskLevel;
  /** 仅明确互不干扰的只读工具设为 true；审批风险低不代表可并发。默认按调用顺序执行。 */
  isConcurrencySafe?: boolean;
  /** 仅收集输入、没有业务副作用；持久化执行允许重放已回答的交互步骤。 */
  interactionOnly?: boolean;
  execute: (args: Static<TParams>, ctx: ToolContext) => Promise<unknown>;
  describeApproval?: (
    args: Static<TParams>,
  ) => { title: string; detail: string } | Promise<{ title: string; detail: string }>;
  /**
   * 工具成功执行后，若返回值隐含"从现在起只能调用这些工具"（例如加载了声明 allowed-tools
   * 的技能），从结果里提取新增的允许列表；返回 undefined/空数组表示不收紧。多次收紧取并集，
   * 不会相互覆盖。定义了这个字段的工具本身永远不受当前收紧状态限制，否则一旦收紧就再也
   * 调不回来。
   */
  restrictsToolsTo?: (result: unknown) => string[] | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

export function defineTool<TParams extends TSchema>(tool: AgentTool<TParams>): AgentTool<TParams> {
  return tool;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyAgentTool>();

  register(...tools: AnyAgentTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name);
  }

  /** 支持通配：`projects.*` 选中该命名空间下所有工具。 */
  select(patterns: string[]): AnyAgentTool[] {
    const all = [...this.tools.values()];
    return all.filter((tool) =>
      patterns.some((p) =>
        p.endsWith(".*") ? tool.name.startsWith(p.slice(0, -1)) : tool.name === p,
      ),
    );
  }

  list(): AnyAgentTool[] {
    return [...this.tools.values()];
  }
}

/** pi-ai 的工具名只允许 [a-zA-Z0-9_-]，内部用点号命名空间，发给模型时转换。 */
export function toWireName(name: string): string {
  return name.replace(/\./g, "__");
}

export function fromWireName(name: string): string {
  return name.replace(/__/g, ".");
}

export function toPiTool(tool: AnyAgentTool): Tool {
  return {
    name: toWireName(tool.name),
    description: tool.description,
    parameters: tool.parameters,
  };
}

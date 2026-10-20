import type { Static, TSchema, Tool } from "@mariozechner/pi-ai";
import type { AgentName, AgentStreamEvent, RiskLevel } from "@agentdesk/shared";

export interface ApprovalRequest {
  title: string;
  detail: string;
  risk: RiskLevel;
  payload: unknown;
}

export interface ToolContext {
  agent: AgentName;
  signal?: AbortSignal;
  emit: (event: AgentStreamEvent) => void;
  /** 返回 true 表示用户批准。 */
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
}

export interface AgentTool<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  /** safe 直接执行；confirm/dangerous 需要人工审批。 */
  risk: RiskLevel;
  /** 按参数动态判定风险，例如白名单内的只读命令可以免审批 */
  riskFor?: (args: Static<TParams>) => RiskLevel;
  execute: (args: Static<TParams>, ctx: ToolContext) => Promise<unknown>;
  describeApproval?: (args: Static<TParams>) => { title: string; detail: string };
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

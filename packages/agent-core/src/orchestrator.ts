import { Type, type Message } from "@mariozechner/pi-ai";
import type { AgentName, AgentStreamEvent, ToolCallRecord } from "@agentdesk/shared";
import { runAgent, type AgentDefinition } from "./agent";
import type { ModelResolver } from "./llm";
import type { SkillRegistry } from "./skills";
import {
  defineTool,
  type ApprovalRequest,
  type RecordArtifactInput,
  type RecordedArtifact,
  type ToolRegistry,
} from "./tools";

export interface OrchestratorDeps {
  agents: AgentDefinition[];
  registry: ToolRegistry;
  resolver: ModelResolver;
  skills?: SkillRegistry;
}

export interface OrchestratorRunOptions {
  history: Message[];
  userMessage: string;
  /** 用户显式指定 Agent 时跳过路由 */
  agent?: AgentName;
  emit: (event: AgentStreamEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  /** 可选：向用户追问并拿到回答文本的能力，透传给 tasks.ask_user 等工具的 ToolContext。 */
  requestAnswer?: (request: ApprovalRequest) => Promise<string>;
  signal?: AbortSignal;
  /** 额外系统上下文，例如召回的长期记忆。总控和被委派的 Agent 都会看到。 */
  context?: string;
  /**
   * 可选：覆盖这次调用可用的工具集（按工具名精确匹配或 `ns.*` 通配，复用
   * ToolRegistry.select 的匹配规则）。不传时沿用现有的"按 agent definition 的 tools
   * 字段匹配"逻辑，不影响任何现有调用方。用于方案关口等需要临时收紧工具范围的场景。
   */
  allowedTools?: string[];
  /** 可选：记录任务产物的能力，透传给 ToolContext，供 tasks.submit_plan 等工具使用。 */
  recordArtifact?: (input: RecordArtifactInput) => RecordedArtifact;
  /**
   * 每次 agents.delegate 委派开始时触发，用于把这次子任务的事件流、审批请求和最终结果
   * 接到独立的追踪通道（例如 Task 引擎里的子 Run）。不传时委派行为与现状完全一致：
   * 事件/审批直接走 opts.emit/opts.requestApproval，不做任何额外路由。
   * 并发委派场景下每次调用都会拿到各自独立的 handle，互不串台。
   */
  onDelegate?: (info: { agent: AgentName; task: string }) => {
    emit: (event: AgentStreamEvent) => void;
    requestApproval: (request: ApprovalRequest) => Promise<boolean>;
    done: (result: { text: string; toolCalls: ToolCallRecord[] } | { error: string }) => void;
  };
}

export interface OrchestratorResult {
  text: string;
  agent: AgentName;
  toolCalls: ToolCallRecord[];
}

const KEYWORD_ROUTES: Array<{ agent: AgentName; words: string[] }> = [
  { agent: "deploy", words: ["部署", "上线", "发布", "宝塔", "服务器", "deploy", "重启"] },
  {
    agent: "research",
    words: ["热榜", "trending", "资讯", "论文", "最新", "学习", "新闻", "讲解"],
  },
  {
    agent: "code",
    words: [
      "cursor",
      "claude",
      "打开项目",
      "写代码",
      "终端",
      "微信",
      "群聊日报",
      "微信日报",
      "群日报",
      "话痨",
    ],
  },
  {
    agent: "project",
    words: ["项目", "仓库", "分支", "提交", "pr", "mr", "issue", "gitee", "gitlab", "github"],
  },
];

/** 无需模型的快速意图判断，用于 UI 提示，以及模型不可用时的兜底路由。 */
export function routeByKeywords(text: string): AgentName | null {
  const lower = text.toLowerCase();
  for (const route of KEYWORD_ROUTES) {
    if (route.words.some((w) => lower.includes(w))) return route.agent;
  }
  return null;
}

/**
 * Orchestrator-Workers 模式：Orchestrator 拥有 agents.delegate 工具，
 * 可在一轮里并行委派多个专用 Agent，再综合它们的结论回答用户。
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private definition(name: AgentName): AgentDefinition {
    const def = this.deps.agents.find((a) => a.name === name);
    if (!def) throw new Error(`Agent 未注册：${name}`);
    return def;
  }

  private toolsFor(def: AgentDefinition) {
    const tools = this.deps.registry.select(def.tools);
    if (this.deps.skills) tools.push(this.deps.skills.createLoadTool());
    return tools;
  }

  async runSpecialist(
    name: AgentName,
    messages: Message[],
    userText: string,
    opts: Pick<
      OrchestratorRunOptions,
      | "emit"
      | "requestApproval"
      | "requestAnswer"
      | "signal"
      | "context"
      | "allowedTools"
      | "recordArtifact"
    >,
  ) {
    const def = this.definition(name);
    const models = await this.deps.resolver.resolve(name);
    const tools = opts.allowedTools
      ? this.deps.registry.select(opts.allowedTools)
      : this.toolsFor(def);
    return runAgent({
      definition: def,
      tools,
      models,
      messages,
      systemPromptSuffix: [opts.context, this.deps.skills?.promptFor(name, userText)]
        .filter(Boolean)
        .join("\n\n"),
      emit: opts.emit,
      requestApproval: opts.requestApproval,
      requestAnswer: opts.requestAnswer,
      recordArtifact: opts.recordArtifact,
      signal: opts.signal,
    });
  }

  async run(opts: OrchestratorRunOptions): Promise<OrchestratorResult> {
    const userMsg: Message = { role: "user", content: opts.userMessage, timestamp: Date.now() };
    const messages = [...opts.history, userMsg];

    if (opts.agent && opts.agent !== "orchestrator") {
      opts.emit({ type: "route", agent: opts.agent, reason: "用户指定" });
      const result = await this.runSpecialist(opts.agent, messages, opts.userMessage, opts);
      return { text: result.text, agent: opts.agent, toolCalls: result.toolCalls };
    }

    const specialists = this.deps.agents.filter((a) => a.name !== "orchestrator");
    const delegated: ToolCallRecord[] = [];
    const delegate = defineTool({
      name: "agents.delegate",
      description: `把子任务委派给专用 Agent，并拿到它的结论。可用 Agent：\n${specialists
        .map((a) => `- ${a.name}: ${a.description}`)
        .join("\n")}`,
      parameters: Type.Object({
        agent: Type.Union(specialists.map((a) => Type.Literal(a.name))),
        task: Type.String({ description: "交给该 Agent 的完整、自包含的任务描述" }),
      }),
      risk: "safe",
      execute: async ({ agent, task }) => {
        opts.emit({ type: "route", agent, reason: task });
        const handle = opts.onDelegate?.({ agent, task });
        const subEmit = handle?.emit ?? opts.emit;
        const subApproval = handle?.requestApproval ?? opts.requestApproval;
        try {
          const sub = await this.runSpecialist(
            agent,
            [{ role: "user", content: task, timestamp: Date.now() }],
            task,
            {
              emit: subEmit,
              requestApproval: subApproval,
              signal: opts.signal,
              context: opts.context,
            },
          );
          delegated.push(...sub.toolCalls);
          handle?.done({ text: sub.text, toolCalls: sub.toolCalls });
          return { agent, answer: sub.text, toolCalls: sub.toolCalls.map((c) => c.name) };
        } catch (error) {
          handle?.done({ error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    });

    const def = this.definition("orchestrator");
    const models = await this.deps.resolver.resolve("orchestrator");
    const hint = routeByKeywords(opts.userMessage);
    const tools = opts.allowedTools
      ? this.deps.registry.select(opts.allowedTools)
      : [...this.toolsFor(def), delegate];
    const result = await runAgent({
      definition: def,
      tools,
      models,
      messages,
      systemPromptSuffix: [
        opts.context,
        hint ? `关键词路由提示：这个请求可能与 ${hint} Agent 相关。` : "",
        this.deps.skills?.promptFor("orchestrator", opts.userMessage) ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      emit: opts.emit,
      requestApproval: opts.requestApproval,
      requestAnswer: opts.requestAnswer,
      recordArtifact: opts.recordArtifact,
      signal: opts.signal,
    });
    return {
      text: result.text,
      agent: "orchestrator",
      toolCalls: [...result.toolCalls, ...delegated],
    };
  }
}

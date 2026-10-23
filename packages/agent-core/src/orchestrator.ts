import { Type, type Message } from "@mariozechner/pi-ai";
import type { AgentName, AgentStreamEvent, ToolCallRecord } from "@agentdesk/shared";
import { runAgent, type AgentDefinition } from "./agent";
import type { ModelResolver } from "./llm";
import type { SkillRegistry } from "./skills";
import { defineTool, type ApprovalRequest, type ToolRegistry } from "./tools";

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
  signal?: AbortSignal;
  /** 额外系统上下文，例如召回的长期记忆。总控和被委派的 Agent 都会看到。 */
  context?: string;
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
    opts: Pick<OrchestratorRunOptions, "emit" | "requestApproval" | "signal" | "context">,
  ) {
    const def = this.definition(name);
    const models = await this.deps.resolver.resolve(name);
    return runAgent({
      definition: def,
      tools: this.toolsFor(def),
      models,
      messages,
      systemPromptSuffix: [opts.context, this.deps.skills?.promptFor(name, userText)]
        .filter(Boolean)
        .join("\n\n"),
      emit: opts.emit,
      requestApproval: opts.requestApproval,
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
        const sub = await this.runSpecialist(
          agent,
          [{ role: "user", content: task, timestamp: Date.now() }],
          task,
          opts,
        );
        delegated.push(...sub.toolCalls);
        return { agent, answer: sub.text, toolCalls: sub.toolCalls.map((c) => c.name) };
      },
    });

    const def = this.definition("orchestrator");
    const models = await this.deps.resolver.resolve("orchestrator");
    const hint = routeByKeywords(opts.userMessage);
    const result = await runAgent({
      definition: def,
      tools: [...this.toolsFor(def), delegate],
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
      signal: opts.signal,
    });
    return {
      text: result.text,
      agent: "orchestrator",
      toolCalls: [...result.toolCalls, ...delegated],
    };
  }
}

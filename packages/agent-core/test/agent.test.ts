import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import type { AgentStreamEvent } from "@agentdesk/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  Type,
  defineTool,
  parseSkill,
  routeByKeywords,
  runAgent,
  toWireName,
  type AgentDefinition,
  type ResolvedModel,
} from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => faux?.unregister());

function setup(): ResolvedModel[] {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  return [{ providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" }];
}

const projectAgent: AgentDefinition = {
  name: "project",
  title: "项目助手",
  description: "查询项目",
  systemPrompt: "你是项目助手",
  tools: ["projects.*"],
};

describe("runAgent", () => {
  it("执行工具调用并把结果回填给模型", async () => {
    const models = setup();
    const listTool = defineTool({
      name: "projects.list",
      description: "列出项目",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => [{ name: "im-server" }],
    });
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("projects.list"), {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("你有 1 个项目：im-server")),
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({
      definition: projectAgent,
      tools: [listTool],
      models,
      messages: [{ role: "user", content: "我有哪些项目", timestamp: Date.now() }],
      emit: (e) => events.push(e),
      requestApproval: async () => true,
    });
    expect(result.text).toBe("你有 1 个项目：im-server");
    expect(result.toolCalls[0]?.name).toBe("projects.list");
    expect(result.toolCalls[0]?.result).toEqual([{ name: "im-server" }]);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("危险工具在用户拒绝时不执行", async () => {
    const models = setup();
    let executed = false;
    const deployTool = defineTool({
      name: "projects.deploy",
      description: "部署",
      parameters: Type.Object({ id: Type.String() }),
      risk: "dangerous",
      execute: async () => {
        executed = true;
        return "ok";
      },
    });
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("projects.deploy"), { id: "im" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("已取消部署")),
    ]);
    const result = await runAgent({
      definition: projectAgent,
      tools: [deployTool],
      models,
      messages: [{ role: "user", content: "部署 im", timestamp: Date.now() }],
      emit: () => {},
      requestApproval: async () => false,
    });
    expect(executed).toBe(false);
    expect(result.toolCalls[0]?.isError).toBe(true);
  });
});

describe("Orchestrator", () => {
  it("通过 agents.delegate 委派给专用 Agent", async () => {
    const models = setup();
    faux!.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("agents.delegate"), { agent: "project", task: "列出项目" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("项目 Agent 结论：有 2 个项目")),
      fauxAssistantMessage(fauxText("你目前有 2 个项目。")),
    ]);
    const orchestrator = new Orchestrator({
      agents: [
        {
          name: "orchestrator",
          title: "总控",
          description: "路由",
          systemPrompt: "总控",
          tools: [],
        },
        projectAgent,
      ],
      registry: new ToolRegistry(),
      resolver: { resolve: async () => models },
    });
    const events: AgentStreamEvent[] = [];
    const result = await orchestrator.run({
      history: [],
      userMessage: "我有几个项目",
      emit: (e) => events.push(e),
      requestApproval: async () => true,
    });
    expect(result.text).toBe("你目前有 2 个项目。");
    expect(events.find((e) => e.type === "route")).toMatchObject({ agent: "project" });
  });
});

describe("routing & skills", () => {
  it("关键词路由", () => {
    expect(routeByKeywords("帮我部署 IM 项目")).toBe("deploy");
    expect(routeByKeywords("今天 GitHub 热榜有什么")).toBe("research");
    expect(routeByKeywords("生成微信群聊日报")).toBe("code");
    expect(routeByKeywords("你好")).toBeNull();
  });

  it("解析 SKILL.md", () => {
    const skill = parseSkill(
      "---\nname: bt-deploy\ndescription: 宝塔部署\nagents: [deploy]\ntriggers: [部署]\n---\n步骤一",
      "/skills/bt-deploy",
    );
    expect(skill.name).toBe("bt-deploy");
    expect(skill.agents).toEqual(["deploy"]);
    expect(skill.instructions).toBe("步骤一");
  });
});

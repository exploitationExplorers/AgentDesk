import { afterEach, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  Orchestrator,
  SkillRegistry,
  ToolRegistry,
  Type,
  defineTool,
  parseSkill,
  toWireName,
  type AgentDefinition,
} from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => faux?.unregister());

it.each(["orchestrator", "code"] as const)(
  "%s 自动触发隔离技能时，在加载前后都不能写入或委派逃逸",
  async (agent) => {
    faux = registerFauxProvider({ tokensPerSecond: 100_000 });
    let writes = 0;
    let reads = 0;
    const registry = new ToolRegistry().register(
      defineTool({
        name: "fs.write",
        description: "write",
        parameters: Type.Object({}),
        risk: "safe",
        execute: async () => {
          writes++;
          return "written";
        },
      }),
      defineTool({
        name: "reading.read",
        description: "read",
        parameters: Type.Object({}),
        risk: "safe",
        execute: async () => {
          reads++;
          return "source";
        },
      }),
    );
    const skills = new SkillRegistry();
    skills.add(
      parseSkill(
        "---\nname: reading\ndescription: read\ntriggers: [源码导读]\nallowed-tools: [reading.read]\nisolate-tools: true\n---\nRead source.",
        "/reading",
      ),
    );
    skills.add(
      parseSkill(
        "---\nname: writer\ndescription: write\nallowed-tools: [fs.write]\n---\nWrite source.",
        "/writer",
      ),
    );
    const definitions: AgentDefinition[] = ["orchestrator", "code"].map((name) => ({
      name: name as "orchestrator" | "code",
      title: name,
      description: name,
      systemPrompt: "test",
      tools: ["fs.write", "reading.read"],
      maxTurns: 12,
    }));
    const orchestrator = new Orchestrator({
      registry,
      skills,
      agents: definitions,
      resolver: {
        resolve: async () => [
          { providerId: "faux", providerName: "faux", apiKey: "x", model: faux!.getModel() },
        ],
      },
    });
    const call = (name: string, args: Record<string, unknown> = {}) =>
      fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });
    faux.setResponses([
      call("fs.write"),
      call("agents.delegate", { agent: "code", task: "write" }),
      call("skills.load", { name: "writer" }),
      call("fs.write"),
      call("skills.load", { name: "reading" }),
      call("reading.read"),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const result = await orchestrator.run({
      agent,
      history: [],
      userMessage: "源码导读",
      emit: () => {},
      requestApproval: async () => true,
    });
    expect(writes).toBe(0);
    expect(reads).toBe(1);
    expect(
      result.toolCalls
        .filter((tool) => ["fs.write", "agents.delegate"].includes(tool.name))
        .every((tool) => tool.isError),
    ).toBe(true);
    faux.setResponses([call("fs.write"), fauxAssistantMessage(fauxText("written"))]);
    await orchestrator.run({
      agent,
      history: [],
      userMessage: "修改文件",
      emit: () => {},
      requestApproval: async () => true,
    });
    expect(writes).toBe(1);
  },
);

it("空允许列表的隔离技能默认拒绝业务工具", async () => {
  const skills = new SkillRegistry();
  skills.add(
    parseSkill(
      "---\nname: empty\ndescription: empty\ntriggers: [isolated]\nisolate-tools: true\n---\nNo tools.",
      "/empty",
    ),
  );
  expect(skills.matchTriggers("code", "isolated")[0]).toMatchObject({
    isolateTools: true,
    allowedTools: [],
  });
});

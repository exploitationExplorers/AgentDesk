import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type Context,
} from "@mariozechner/pi-ai";
import { toWireName, type ToolContext } from "@agentdesk/agent-core";
import { createContainer } from "../src/container";
import { loadConfig } from "../src/config";

function toolResult(context: Context, tool: string): Record<string, unknown> {
  const message = context.messages.findLast(
    (m) => m.role === "toolResult" && m.toolName === toWireName(tool),
  );
  if (!message || message.role !== "toolResult") throw new Error(`Missing result: ${tool}`);
  return JSON.parse(
    message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(""),
  ) as Record<string, unknown>;
}

it("真实容器加载公开技能，Bot 完成导读工具链并在新一轮恢复独立问答", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-reading-chat-"));
  const container = await createContainer(loadConfig({ AGENTDESK_DATA_DIR: root }), {
    inMemory: true,
  });
  const faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  try {
    execFileSync("git", ["init", root], { windowsHide: true, stdio: "ignore" });
    await writeFile(join(root, "main.py"), "def welcome():\n    return 'hello'\n");
    const project = await container.projects.add(root);
    container.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", apiKey: "x", model: faux.getModel() },
    ];
    const skill = container.skills.get("repo-walkthrough")!;
    expect(skill.isolateTools).toBe(true);
    for (const name of skill.allowedTools) expect(container.registry.get(name), name).toBeDefined();
    let id = "";
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });
    faux.setResponses([
      call("skills.load", { name: "repo-walkthrough" }),
      call("reading.open", { target: project.id }),
      (context) => {
        id = String(toolResult(context, "reading.open").sessionId);
        return call("reading.read", { sessionId: id, path: "main.py" });
      },
      (context) =>
        call("reading.slice", {
          sessionId: id,
          path: "main.py",
          expectedHash: toolResult(context, "reading.read").hash,
          slices: [{ startLine: 1, endLine: 3, title: "welcome 返回问候语", role: "返回 hello" }],
        }),
      () => call("reading.ask", { sessionId: id, question: "welcome 做了什么" }),
      (context) => {
        expect(context.tools?.map((t) => t.name)).toEqual([
          toWireName("reading.read"),
          toWireName("reading.search"),
        ]);
        return fauxAssistantMessage(fauxText("main.py:1 定义 welcome，第二行返回 hello。"));
      },
      fauxAssistantMessage(fauxText("main.py:1 定义 welcome，第二行返回 hello。")),
    ]);
    const result = await container.orchestrator.run({
      history: [],
      userMessage: `带我读懂项目 ${project.id}`,
      emit: () => {},
      requestApproval: async () => false,
    });
    expect(result.toolCalls.every((tool) => !tool.isError)).toBe(true);
    expect(result.text).toContain("main.py:1");
    expect(result.toolCalls.map((tool) => tool.name)).toContain("reading.ask");
    const ctx: ToolContext = {
      agent: "orchestrator",
      emit: () => {},
      requestApproval: async () => false,
    };
    const state = await container.registry.get("reading.summary")!.execute({ sessionId: id }, ctx);
    expect(JSON.stringify(state)).toContain("welcome 做了什么");
    faux.setResponses([
      call("skills.load", { name: "repo-walkthrough" }),
      call("reading.focus", { sessionId: id }),
      call("reading.ask", { sessionId: id, question: "返回的是字符串吗" }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("welcome 做了什么");
        return fauxAssistantMessage(fauxText("是字符串 hello。"));
      },
      fauxAssistantMessage(fauxText("是字符串 hello。")),
    ]);
    const resumed = await container.orchestrator.run({
      history: [],
      userMessage: "接着上次讲",
      emit: () => {},
      requestApproval: async () => false,
    });
    expect(resumed.toolCalls.every((tool) => !tool.isError)).toBe(true);
    expect(resumed.text).toContain("字符串");
  } finally {
    faux.unregister();
    await container.dispose();
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

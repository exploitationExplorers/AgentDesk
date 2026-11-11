import { describe, expect, it } from "vitest";
import { parseSkill, SkillRegistry } from "../src/skills";
import type { ToolContext } from "../src/tools";

const context: ToolContext = { agent: "code", emit: () => {}, requestApproval: async () => false };
const source = (metadata: string) =>
  `---\nname: release\ndescription: Release procedure\n${metadata}\n---\nRun the release checks.`;

describe("技能兼容与模型调用边界", () => {
  it("支持标准短横线工具字段，并保留带空格的规则和旧数组格式", () => {
    expect(
      parseSkill(source("allowed-tools: Read, Bash(npm test) Write"), "/skills").allowedTools,
    ).toEqual(["Read", "Bash(npm test)", "Write"]);
    expect(
      parseSkill(source("allowed_tools: [fs.read, shell.run]"), "/skills").allowedTools,
    ).toEqual(["fs.read", "shell.run"]);
    expect(
      parseSkill(source("allowed-tools: [Read]\nallowed_tools: [shell.run]"), "/skills")
        .allowedTools,
    ).toEqual(["Read"]);
  });

  it("禁用模型调用的技能不进入目录或触发注入，也不能按名称加载", async () => {
    const registry = new SkillRegistry();
    registry.add(
      parseSkill(source("disable-model-invocation: true\ntriggers: [release]"), "/skills"),
    );
    expect(registry.promptFor("code", "release")).toBe("");
    expect(registry.matchTriggers("code", "release")).toEqual([]);
    await expect(registry.createLoadTool().execute({ name: "release" }, context)).rejects.toThrow(
      "不允许模型主动调用",
    );
    expect(registry.list()).toHaveLength(1);
  });

  it("隐藏用户菜单的技能仍可由模型加载，Agent 限制在加载时生效", async () => {
    const registry = new SkillRegistry();
    registry.add(parseSkill(source("user-invocable: false\nagents: [code]"), "/skills"));
    expect(registry.get("release")?.userInvocable).toBe(false);
    expect(registry.promptFor("code", "hello")).toContain("release");
    await expect(
      registry.createLoadTool().execute({ name: "release" }, context),
    ).resolves.toMatchObject({ name: "release" });
    await expect(
      registry.createLoadTool().execute({ name: "release" }, { ...context, agent: "research" }),
    ).rejects.toThrow("不适用于");
  });

  it("@提及可显式激活用户可调用的技能，包括禁止模型主动加载的技能", () => {
    const registry = new SkillRegistry();
    registry.add(
      parseSkill(
        source("disable-model-invocation: true\nuser-invocable: true\nagents: [code]"),
        "/skills",
      ),
    );
    registry.add(
      parseSkill(
        "---\nname: qa-regression\ndescription: E2E\nuser-invocable: true\nagents: [code]\n---\nRun QA.",
        "/skills",
      ),
    );
    registry.add(
      parseSkill(
        "---\nname: hidden-ops\ndescription: Hidden\nuser-invocable: false\nagents: [code]\n---\nSecret.",
        "/hidden",
      ),
    );
    expect(registry.matchMentions("code", "请用 @qa-regression 跑一轮").map((s) => s.name)).toEqual(
      ["qa-regression"],
    );
    expect(registry.matchActivated("code", "请用 @release 发布").map((s) => s.name)).toEqual([
      "release",
    ]);
    expect(registry.matchMentions("code", "忽略 @release-extra")).toEqual([]);
    expect(registry.promptFor("code", "@release 开始")).toContain("本轮已激活的技能");
    expect(registry.matchMentions("code", "不可点选 @hidden-ops").map((s) => s.name)).toEqual([]);
  });

  it("declareTools().restrictsToolsTo 按技能的 allowed-tools 收紧，空数组不收紧", async () => {
    const registry = new SkillRegistry();
    registry.add(parseSkill(source("allowed-tools: [Read, shell.run]"), "/skills"));
    registry.add(parseSkill("---\nname: no-limit\ndescription: 无限制\n---\n指令", "/skills"));
    const loadTool = registry.createLoadTool();
    const result = await loadTool.execute({ name: "release" }, context);
    expect(loadTool.restrictsToolsTo?.(result)).toEqual(["Read", "shell.run"]);
    const unrestricted = await loadTool.execute({ name: "no-limit" }, context);
    expect(loadTool.restrictsToolsTo?.(unrestricted)).toBeUndefined();
  });
});

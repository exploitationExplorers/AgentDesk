import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMention, mentionQuery, mentionSuggestions } from "../src/interactive/mentions.js";

describe("skill mentions", () => {
  const skills = [
    {
      name: "qa-regression",
      description: "自然语言端到端回归测试",
      userInvocable: true,
      agents: ["orchestrator", "code"],
    },
    {
      name: "repo-walkthrough",
      description: "源码导读",
      userInvocable: true,
      agents: ["code"],
    },
    {
      name: "secret-ops",
      description: "隐藏技能",
      userInvocable: false,
      agents: ["code"],
    },
  ];

  it("detects an active @ query at the end of input", () => {
    assert.deepEqual(mentionQuery("请用 @qa"), { start: 3, query: "qa" });
    assert.equal(mentionQuery("请用 @qa 继续"), null);
    assert.equal(mentionQuery("email@example.com"), null);
  });

  it("filters invocable skills for the current agent", () => {
    assert.deepEqual(
      mentionSuggestions("@", skills, "orchestrator").map((skill) => skill.name),
      ["qa-regression"],
    );
    assert.deepEqual(
      mentionSuggestions("@qa", skills, "code").map((skill) => skill.name),
      ["qa-regression"],
    );
    assert.equal(mentionSuggestions("@secret", skills, "code").length, 0);
  });

  it("replaces the partial mention with a completed token", () => {
    assert.equal(applyMention("请用 @qa", 3, "qa-regression"), "请用 @qa-regression ");
    assert.equal(applyMention("@", 0, "repo-walkthrough"), "@repo-walkthrough ");
  });
});

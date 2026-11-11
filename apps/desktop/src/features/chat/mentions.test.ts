import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyMentionAt, filterMentionSkills, mentionQueryAt } from "./mentions";

describe("composer skill mentions", () => {
  const skills = [
    {
      name: "qa-regression",
      description: "自然语言端到端回归测试",
      version: "1.0.0",
      agents: ["orchestrator", "code"],
      triggers: ["回归测试"],
      dir: "/skills/qa-regression",
      userInvocable: true,
    },
    {
      name: "bt-deploy",
      description: "宝塔部署",
      version: "1.0.0",
      agents: ["deploy"],
      triggers: ["部署"],
      dir: "/skills/bt-deploy",
      userInvocable: true,
    },
  ];

  it("resolves the active @ token from the caret", () => {
    assert.deepEqual(mentionQueryAt("请用 @qa", 6), { start: 3, query: "qa", end: 6 });
    assert.deepEqual(mentionQueryAt("请用 @qa 继续", 6), { start: 3, query: "qa", end: 6 });
    assert.equal(mentionQueryAt("请用 @qa 继续", 8), null);
  });

  it("filters skills for the current agent", () => {
    assert.deepEqual(
      filterMentionSkills(skills, "", "orchestrator").map((skill) => skill.name),
      ["qa-regression"],
    );
    assert.deepEqual(
      filterMentionSkills(skills, "bt", "deploy").map((skill) => skill.name),
      ["bt-deploy"],
    );
  });

  it("inserts the completed mention at the caret", () => {
    assert.deepEqual(applyMentionAt("请用 @qa", 3, 6, "qa-regression"), {
      value: "请用 @qa-regression ",
      caret: 18,
    });
  });
});

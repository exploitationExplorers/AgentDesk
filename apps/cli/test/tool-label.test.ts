import assert from "node:assert/strict";
import { test } from "node:test";
import { toolLabel } from "../src/interactive/tool-label.js";

test("skills.load 显示专属动作名和技能名，而不是通用的「处理」", () => {
  const label = toolLabel("skills.load", { name: "bt-deploy" });
  assert.equal(label.action, "加载技能");
  assert.equal(label.target, "bt-deploy");
});

test("未登记的工具名回退到「处理」，不展示内部工具名", () => {
  const label = toolLabel("some.unmapped_tool", {});
  assert.equal(label.action, "处理");
});

test("没有点号的工具名原样展示", () => {
  const label = toolLabel("ping", {});
  assert.equal(label.action, "ping");
});

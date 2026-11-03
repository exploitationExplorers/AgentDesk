import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { defaultPatternFor, PermissionRuleService } from "../src/services/permission-rules";

let handle: DbHandle;
let rules: PermissionRuleService;

beforeEach(() => {
  handle = openDatabase(":memory:");
  rules = new PermissionRuleService(handle.db);
});

afterEach(() => {
  handle.close();
});

describe("defaultPatternFor", () => {
  it("shell.run 取命令前两个词作为前缀", () => {
    expect(defaultPatternFor("shell.run", { command: "npm run build --watch" })).toBe("npm run");
  });

  it("fs.write 没有更短的自然前缀，直接用完整路径", () => {
    expect(defaultPatternFor("fs.write", { path: "src/index.ts" })).toBe("src/index.ts");
  });

  it("deploy.run 用完整 recipeId", () => {
    expect(defaultPatternFor("deploy.run", { recipeId: "prod-deploy" })).toBe("prod-deploy");
  });

  it("未登记的工具或缺字段返回 undefined", () => {
    expect(defaultPatternFor("fs.read", { path: "src/index.ts" })).toBeUndefined();
    expect(defaultPatternFor("shell.run", {})).toBeUndefined();
  });
});

describe("PermissionRuleService", () => {
  it("命中 allow 规则后放行同前缀的后续命令", () => {
    rules.add("shell.run", "npm run", "allow");
    const rule = rules.match("shell.run", { command: "npm run build" });
    expect(rule?.decision).toBe("allow");
    expect(rules.match("shell.run", { command: "pnpm run build" })).toBeUndefined();
  });

  it("deny 永远优先于 allow：同一前缀下两条规则都命中时返回 deny", () => {
    rules.add("shell.run", "npm run", "allow");
    rules.add("shell.run", "npm run", "deny");
    const rule = rules.match("shell.run", { command: "npm run build" });
    expect(rule?.decision).toBe("deny");
  });

  it("空 pattern 对该工具的所有调用生效", () => {
    rules.add("deploy.run", "", "deny");
    expect(rules.match("deploy.run", { recipeId: "anything" })?.decision).toBe("deny");
    expect(rules.match("deploy.run", {})?.decision).toBe("deny");
  });

  it("fs.write 按路径匹配，不影响其他文件", () => {
    rules.add("fs.write", "src/index.ts", "allow");
    expect(rules.match("fs.write", { path: "src/index.ts" })?.decision).toBe("allow");
    expect(rules.match("fs.write", { path: "src/other.ts" })).toBeUndefined();
  });

  it("规则只对声明的 tool 生效，不会跨工具命中", () => {
    rules.add("shell.run", "npm run", "deny");
    expect(rules.match("fs.write", { path: "npm run" })).toBeUndefined();
  });

  it("tool+pattern+decision 相同的规则不会重复新增", () => {
    const first = rules.add("shell.run", "npm run", "allow");
    const second = rules.add("shell.run", "npm run", "allow");
    expect(second.id).toBe(first.id);
    expect(rules.list()).toHaveLength(1);
  });

  it("同一 tool+pattern 的 allow 和 deny 是两条独立规则", () => {
    rules.add("shell.run", "npm run", "allow");
    rules.add("shell.run", "npm run", "deny");
    expect(rules.list()).toHaveLength(2);
  });

  it("remove 删除后不再命中", () => {
    const rule = rules.add("shell.run", "npm run", "allow");
    expect(rules.remove(rule.id)).toBe(true);
    expect(rules.match("shell.run", { command: "npm run build" })).toBeUndefined();
  });
});

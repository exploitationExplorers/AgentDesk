import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelResolver } from "@agentdesk/agent-core";
import { openDatabase, type DbHandle } from "../src/db/client";
import { createAutoApprove } from "../src/services/auto-approve";
import { PermissionRuleService } from "../src/services/permission-rules";
import { SettingsService } from "../src/services/settings";

let handle: DbHandle;
let rules: PermissionRuleService;
let settings: SettingsService;
const models = {} as ModelResolver;

beforeEach(() => {
  handle = openDatabase(":memory:");
  rules = new PermissionRuleService(handle.db);
  settings = new SettingsService(handle.db);
});

afterEach(() => {
  handle.close();
});

describe("createAutoApprove", () => {
  it("命中 allow 规则直接放行，不会去问分类器", async () => {
    rules.add("shell.run", "npm run", "allow");
    const autoApprove = createAutoApprove(rules, models, settings);
    const result = await autoApprove("shell.run", { command: "npm run build" }, "dangerous");
    expect(result).toMatchObject({ approved: true, source: "rule" });
  });

  it("命中 deny 规则直接拒绝，不回退到分类器或正常审批", async () => {
    rules.add("shell.run", "npm run", "deny");
    const autoApprove = createAutoApprove(rules, models, settings);
    const result = await autoApprove("shell.run", { command: "npm run build" }, "dangerous");
    expect(result.approved).toBe(false);
    expect((result as { note?: string }).note).toMatch(/已记住拒绝/);
  });

  it("deny 规则同样适用于 fs.write 等非 shell.run 工具", async () => {
    rules.add("fs.write", "src/secrets.ts", "deny");
    const autoApprove = createAutoApprove(rules, models, settings);
    const result = await autoApprove("fs.write", { path: "src/secrets.ts" }, "confirm");
    expect(result.approved).toBe(false);
  });

  it("没有规则命中、分类器关闭时回退到正常审批", async () => {
    const autoApprove = createAutoApprove(rules, models, settings);
    const result = await autoApprove("shell.run", { command: "rm -rf /" }, "dangerous");
    expect(result).toEqual({ approved: false });
  });
});

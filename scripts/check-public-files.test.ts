import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFile } from "./check-public-files.js";

test("拒绝本地环境文件、私有技能和运行数据，允许环境模板", () => {
  for (const file of [
    ".env",
    "apps/sidecar/.env.production",
    ".env.local",
    "dev-master.key",
    "data/agentdesk.sqlite-wal",
    "data/browser-profiles/state.json",
    "apps/sidecar/skills/wechat-daily-report/SKILL.md",
    ".tmp-run.json",
  ]) {
    assert.equal(inspectFile(file, Buffer.from("local")).length, 1, file);
  }
  for (const file of [".env.example", "apps/sidecar/.env.production.example", "src/secrets.ts"]) {
    assert.deepEqual(inspectFile(file, Buffer.from("example")), []);
  }
});

test("检测 AI、GitHub、GitLab、Gitee 密钥时仅返回位置", () => {
  const values = [
    ["sk-", "ghp_", "github_pat_", "glpat-"].map((prefix) => prefix + "a".repeat(40)),
    ["b".repeat(40)],
  ].flat();
  for (const value of values) {
    const issues = inspectFile("src/config.ts", Buffer.from(`const token = '${value}';`));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.line, 1);
    assert.equal(JSON.stringify(issues).includes(value), false);
  }
});

test("允许占位测试值和动态配置，检测私钥", () => {
  assert.deepEqual(
    inspectFile("test/config.ts", Buffer.from('apiKey: "test-placeholder-value"')),
    [],
  );
  assert.deepEqual(inspectFile("src/config.ts", Buffer.from("apiKey: process.env.API_KEY")), []);
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  assert.equal(inspectFile("src/key.txt", Buffer.from(header)).length, 1);
});

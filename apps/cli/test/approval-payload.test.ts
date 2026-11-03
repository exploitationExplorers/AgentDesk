import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalOptionsFor } from "../src/interactive/approval/payload.js";

function payload(tool: string, args: unknown) {
  return { tool, args };
}

test("shell.run 能算出前缀时提供批准/拒绝并记住两个选项", () => {
  const options = approvalOptionsFor(payload("shell.run", { command: "npm run build --watch" }));
  assert.deepEqual(
    options.map((o) => o.id),
    ["yes", "yes_remember", "no", "no_remember"],
  );
  assert.match(options[1]!.label, /"npm run" 开头的命令/);
  assert.match(options[3]!.label, /"npm run" 开头的命令/);
});

test("fs.write 按文件路径提供记住选项", () => {
  const options = approvalOptionsFor(payload("fs.write", { path: "src/index.ts" }));
  assert.deepEqual(
    options.map((o) => o.id),
    ["yes", "yes_remember", "no", "no_remember"],
  );
  assert.match(options[1]!.label, /文件 src\/index\.ts/);
});

test("deploy.run 按配方 ID 提供记住选项", () => {
  const options = approvalOptionsFor(payload("deploy.run", { recipeId: "prod-deploy" }));
  assert.deepEqual(
    options.map((o) => o.id),
    ["yes", "yes_remember", "no", "no_remember"],
  );
  assert.match(options[1]!.label, /部署配方 prod-deploy/);
});

test("未知工具或缺字段只有批准/拒绝两个选项", () => {
  const unknown = approvalOptionsFor(payload("fs.read", { path: "src/index.ts" }));
  assert.deepEqual(
    unknown.map((o) => o.id),
    ["yes", "no"],
  );
  const missingField = approvalOptionsFor(payload("shell.run", {}));
  assert.deepEqual(
    missingField.map((o) => o.id),
    ["yes", "no"],
  );
});

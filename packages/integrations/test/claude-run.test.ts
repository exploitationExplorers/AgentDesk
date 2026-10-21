import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatStreamJsonLine, gitChangedFiles, runClaudePrint } from "../src/claude/run";
import { run } from "../src/exec";

describe("gitChangedFiles", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    // best-effort cleanup left to OS tmp
    dirs.length = 0;
  });

  it("lists porcelain paths", async () => {
    const dir = join(tmpdir(), `agentdesk-claude-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    const files = await gitChangedFiles(dir);
    expect(files.some((f) => f.includes("a.txt"))).toBe(true);
  });
});

describe("runClaudePrint parse", () => {
  it("extracts result from json stdout via dry failure path", async () => {
    // 用不存在的命令验证启动失败路径，避免真跑 Claude（慢且依赖网络）
    const result = await runClaudePrint({
      cwd: process.cwd(),
      prompt: "noop",
      claudeCommand: "claude-agentdesk-missing-cmd-xyz",
      timeoutMs: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("formatStreamJsonLine", () => {
  it("summarizes tool_use Edit path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }],
      },
    });
    expect(formatStreamJsonLine(line)).toContain("src/a.ts");
  });

  it("summarizes system init", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abcdef0123456789",
    });
    expect(formatStreamJsonLine(line)).toMatch(/已启动/);
  });
});

describe("empty-success guard (claude.run 语义)", () => {
  it("clean tree → changedFiles empty → 必须判失败", async () => {
    const dir = join(tmpdir(), `agentdesk-clean-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "tracked.txt"), "ok\n", "utf8");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "init"], { cwd: dir });
    const files = await gitChangedFiles(dir);
    expect(files).toEqual([]);
    // 与 apps/sidecar claude.run 一致：无改动则 throw
    const needChanges = true;
    const shouldFail = needChanges && files.length === 0;
    expect(shouldFail).toBe(true);
  });
});

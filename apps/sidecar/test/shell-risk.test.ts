import { describe, expect, it } from "vitest";
import { shellRisk } from "../src/agents/tools";

describe("shellRisk", () => {
  it.each([
    "git status --short",
    "git status --porcelain=v1",
    "git branch",
    "git branch -a -vv",
    "git branch --show-current",
    "git remote -v",
    "git diff --stat",
    "git diff --cached --name-only",
    "git log --oneline -n 5",
    "git log -5",
    "git show HEAD --stat",
    "git show HEAD:src/index.ts",
    "node --version",
    "pwd",
    "whoami",
    "ls -lah",
    "dir /b",
    "echo hello",
  ])("已知只读命令免审批：%s", (command) => {
    expect(shellRisk(command)).toBe("safe");
  });

  it.each([
    "git branch -D work",
    "git branch --delete work",
    "git branch -m old new",
    "git branch new",
    "git branch --set-upstream-to=origin/main",
    "git fetch",
    "git remote -v add origin url",
    "git diff --output=result.txt",
    "git log --output=result.txt",
    "git show --output=result.txt",
    "git diff --ext-diff",
    "git show --textconv",
    "git log --unknown-option",
    "git -c core.pager=command log",
    "git status\ngit branch -D work",
    "git status && echo x",
    "echo %PATH%",
    "echo !command!",
    "echo x^& command",
    "echo $(command)",
    "echo `command`",
    "echo x > file",
    "git status | command",
    "git log -n",
    "git log -n nope",
    'git branch "new name"',
    "dir /b & command",
    "npm run build",
    "",
  ])("变更、展开和未知参数仍需审批：%s", (command) => {
    expect(shellRisk(command)).toBe("dangerous");
  });
});

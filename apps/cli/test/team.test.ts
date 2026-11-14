import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { executeTeamTask, LocalTeamRunner, runTeamProcess } from "../src/team/runner.js";
import { parseCommand } from "../src/args.js";
import { teamOrigin, teamRequest } from "../src/team/client.js";
import type { TeamClaim } from "@agentdesk/shared";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
test("team 命令解析与服务器地址不允许凭据或非 TLS 公网", () => {
  assert.equal(
    parseCommand(["team", "work", "--repo", "repo", "--runner-config", "config.json", "--once"])
      .command,
    "team",
  );
  assert.equal(parseCommand(["team", "say", "共同核对接口"]).positionals[1], "共同核对接口");
  assert.throws(() => parseCommand(["team", "erase"]));
  assert.throws(() => teamOrigin("http://example.com"));
  assert.throws(() => teamOrigin("https://user:password@example.com"));
  assert.equal(teamOrigin("http://127.0.0.1:17895"), "http://127.0.0.1:17895");
});
test("真实 Git worktree、个人 Agent 进程、检查、推送与多分支集成", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdesk-team-"));
  const bare = join(directory, "remote.git"),
    repo = join(directory, "repo");
  mkdirSync(repo);
  git(directory, "init", "--bare", bare);
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const base = git(repo, "rev-parse", "HEAD");
  const repository = "https://example.com/team/im.git";
  git(repo, "remote", "add", "origin", repository);
  git(repo, "config", `url.${bare.replaceAll("\\", "/")}.insteadOf`, repository);
  git(repo, "push", "origin", "HEAD:main");
  const script = join(directory, "agent.cjs");
  writeFileSync(
    script,
    `const fs=require('node:fs');const cp=require('node:child_process');
const feature=process.argv[2]; fs.writeFileSync(feature+'.txt', 'implemented');
if(feature==='secret-history') fs.writeFileSync(feature+'.txt', 'sk-'+ 'x'.repeat(32));
cp.execFileSync('git',['add',feature+'.txt']); cp.execFileSync('git',['commit','-m','feat: '+feature]);
if(feature==='secret-history') {
  fs.writeFileSync(feature+'.txt', 'removed');
  cp.execFileSync('git',['add',feature+'.txt']); cp.execFileSync('git',['commit','-m','fix: remove secret']);
}`,
  );
  const claim = (title: string): TeamClaim => {
    const id = randomUUID();
    return {
      lease: "test",
      room: {
        id: "room",
        name: "IM",
        goal: "IM开发",
        repository,
        baseRevision: base,
        ownerId: "owner",
        createdAt: new Date().toISOString(),
      },
      dependencies: [],
      task: {
        id,
        roomId: "room",
        title,
        instructions: "实现功能",
        acceptance: ["检查通过"],
        assigneeId: "member",
        kind: "develop",
        dependsOn: [],
        branch: `agentdesk/${id}-1`,
        baseRevision: base,
        attempt: 1,
        status: "running",
        progress: "",
        createdAt: "",
        updatedAt: "",
      },
    };
  };
  try {
    const a = claim("accounts"),
      b = claim("messages");
    async function run(input: TeamClaim, feature: string) {
      const config = LocalTeamRunner.parse({
        executor: "custom",
        command: process.execPath,
        args: [script, feature],
        checks: [
          {
            name: "检查交付",
            command: process.execPath,
            args: [
              "-e",
              "if(require('node:child_process').execFileSync('git',['status','--porcelain']).length)process.exit(1)",
            ],
          },
        ],
      });
      return executeTeamTask({
        claim: input,
        repo,
        config,
        signal: new AbortController().signal,
        confirm: async () => true,
        summarize: async () => "已完成并检查",
        progress: () => undefined,
      });
    }
    const first = await run(a, "accounts");
    const second = await run(b, "messages");
    assert.notEqual(first.revision, base);
    assert.notEqual(second.revision, base);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    const integration = claim("IM 集成回归");
    integration.task.kind = "integrate";
    integration.task.dependsOn = [a.task.id, b.task.id];
    integration.dependencies = [
      { ...a.task, status: "approved", delivery: first },
      { ...b.task, status: "approved", delivery: second },
    ];
    const aggregate = await run(integration, "unused");
    const tree = git(repo, "ls-tree", "--name-only", aggregate.revision);
    assert.match(tree, /accounts.txt/);
    assert.match(tree, /messages.txt/);
    assert.equal(
      git(directory, "--git-dir", bare, "rev-parse", integration.task.branch),
      aggregate.revision,
    );
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "initial\n");
    const secretHistory = claim("历史中的秘密也不能推送");
    await assert.rejects(run(secretHistory, "secret-history"), /疑似密钥/);
    assert.throws(() =>
      git(directory, "--git-dir", bare, "rev-parse", "--verify", secretHistory.task.branch),
    );
    const declined = claim("拒绝执行");
    await assert.rejects(
      executeTeamTask({
        claim: declined,
        repo,
        config: LocalTeamRunner.parse({
          executor: "custom",
          command: process.execPath,
          checks: [{ name: "test", command: process.execPath, args: ["-e", ""] }],
        }),
        signal: new AbortController().signal,
        confirm: async () => false,
        summarize: async () => "",
        progress: () => undefined,
      }),
      /未批准/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("HTTP 重定向不能带走团队 bearer 凭证", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(307, { Location: "https://example.com/leak" });
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      teamRequest(`http://127.0.0.1:${address.port}`, "never-forward-this", "/room"),
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("连接撤权的 AbortSignal 停止实际本机进程", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdesk-team-stop-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const code = await runTeamProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      directory,
      controller.signal,
    );
    assert.equal(code, 1);
  } finally {
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  }
});

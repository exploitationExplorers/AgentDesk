import { describe, expect, it } from "vitest";
import {
  OwnerEmail,
  RemoteCommand,
  RemoteTaskInput,
  SnapshotManifest,
  SnapshotPath,
  httpStatusOf,
  ErrorCode,
} from "../src/index";

describe("远程输入契约", () => {
  it("只接受明确执行器和工作区 ID，拒绝路径和模型自批字段", () => {
    const task = {
      clientRequestId: "request-1",
      goal: "Fix",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: "work-1",
    };
    expect(RemoteTaskInput.parse(task).requiresPlanApproval).toBe(true);
    expect(RemoteTaskInput.safeParse({ ...task, approved: true }).success).toBe(false);
    expect(RemoteTaskInput.safeParse({ ...task, workspace: "/www/wwwroot" }).success).toBe(false);
    expect(RemoteTaskInput.safeParse({ ...task, executor: "provider-named-codex" }).success).toBe(
      false,
    );
    expect(OwnerEmail.parse(" Owner@Example.com ")).toBe("owner@example.com");
  });

  it("协议版本、actor 和时间窗不匹配时拒绝命令", () => {
    const command = {
      protocolVersion: 1,
      messageId: "m1",
      requestId: "r1",
      userId: "u1",
      hostId: "cloud",
      projectId: "p1",
      workspaceId: "w1",
      actor: { userId: "u1", sessionId: "s1", recentAuthAt: "2026-11-08T10:00:00.000Z" },
      connectionEpoch: 1,
      action: "task.create",
      payloadHash: "a".repeat(64),
      issuedAt: "2026-11-08T10:00:00.000Z",
      expiresAt: "2026-11-08T10:00:30.000Z",
    };
    expect(RemoteCommand.safeParse(command).success).toBe(true);
    expect(RemoteCommand.safeParse({ ...command, protocolVersion: 2 }).success).toBe(false);
    expect(RemoteCommand.safeParse({ ...command, userId: "u2" }).success).toBe(false);
    expect(RemoteCommand.safeParse({ ...command, expiresAt: command.issuedAt }).success).toBe(
      false,
    );
  });

  it("错误区分认证、授权、状态冲突、限流、宿主离线", () => {
    expect(httpStatusOf(ErrorCode.Unauthorized)).toBe(401);
    expect(httpStatusOf(ErrorCode.Forbidden)).toBe(403);
    expect(httpStatusOf(ErrorCode.IdempotencyConflict)).toBe(409);
    expect(httpStatusOf(ErrorCode.RateLimited)).toBe(429);
    expect(httpStatusOf(ErrorCode.HostOffline)).toBe(503);
  });
});

describe("跨平台快照契约", () => {
  it.each([
    "../file",
    "/etc/passwd",
    "C:/secret",
    "dir\\file",
    "dir/../file",
    "dir//file",
    "a\0b",
    ".git/config",
    "dir/.GIT/config",
    "a.",
    "a ",
    "NUL.txt",
    "dir/COM1",
    "a:b",
    "dir/a\nb",
    "e\u0301.txt",
  ])("拒绝危险或有歧义路径 %j", (path) => {
    expect(SnapshotPath.safeParse(path).success).toBe(false);
  });
  it("保留中文、空格和普通特殊文件名", () => {
    expect(SnapshotPath.parse("代码/hello world-你好.ts")).toBe("代码/hello world-你好.ts");
  });
  it("拒绝大小写碰撞、文件目录冲突、超额与 symlink", () => {
    const entry = {
      kind: "file",
      path: "a.txt",
      sha256: "b".repeat(64),
      size: 10 * 1024 * 1024,
      executable: false,
      sourceStatus: "unstaged",
    };
    const manifest = {
      version: 1,
      snapshotId: "s1",
      sourceHostId: "h1",
      sourceProjectId: "p1",
      sourceWorkspaceId: "w1",
      repositoryIdentity: "github.com/owner/repo",
      sourceHead: "a".repeat(40),
      indexTree: "b".repeat(40),
      branch: "main",
      capturedAt: "2026-11-08T10:00:00.000Z",
      entries: [entry],
      exclusions: [],
    };
    expect(SnapshotManifest.safeParse(manifest).success).toBe(true);
    for (const entries of [
      [entry, { ...entry, path: "A.txt" }],
      [entry, { ...entry, path: "a.txt/child" }],
      Array.from({ length: 11 }, (_, i) => ({ ...entry, path: `${i}.bin` })),
      [{ ...entry, kind: "symlink" }],
    ])
      expect(SnapshotManifest.safeParse({ ...manifest, entries }).success).toBe(false);
  });
});

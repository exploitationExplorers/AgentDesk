import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RemoteCommand, type RemoteCapability } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { ApprovalService } from "../src/services/approvals";
import { RemoteApprovalService } from "../src/services/remote/approvals";
import { RemoteGrantStore } from "../src/services/remote/grants";
import { RemoteOperationStore } from "../src/services/remote/operations";
import { payloadDigest } from "../src/services/remote/digest";
import { gitValue, repositoryGit } from "../src/services/remote/repository-git";
import { RepositoryLockManager } from "../src/services/remote/repository-locks";
import {
  RepositoryOperationService,
  type RepositoryPreview,
  type RepositoryExecuteInput,
} from "../src/services/remote/repository-operations";

const scope = { userId: "owner", hostId: "cloud", projectId: "project", workspaceId: "workspace" };
const directories: string[] = [];
const databases: DbHandle[] = [];
vi.setConfig({ testTimeout: 60_000 });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function command(action: RemoteCapability, input: { clientRequestId: string }): RemoteCommand {
  return {
    ...scope,
    protocolVersion: 1,
    messageId: randomUUID(),
    requestId: input.clientRequestId,
    actor: { userId: scope.userId, sessionId: "session", recentAuthAt: new Date().toISOString() },
    connectionEpoch: 1,
    action,
    payloadHash: payloadDigest(input),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 59_000).toISOString(),
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agentdesk-git-"));
  directories.push(dir);
  const workspace = join(dir, "work");
  const remote = join(dir, "remote.git");
  await mkdir(workspace);
  await repositoryGit(workspace, ["init", "--initial-branch=main"]);
  await repositoryGit(workspace, ["config", "user.name", "AgentDesk Test"]);
  await repositoryGit(workspace, ["config", "user.email", "agentdesk@example.com"]);
  await repositoryGit(workspace, ["config", "commit.gpgsign", "false"]);
  await repositoryGit(workspace, ["config", "core.autocrlf", "false"]);
  await writeFile(join(workspace, "selected.txt"), "first\n");
  await writeFile(join(workspace, "other.txt"), "original\n");
  await repositoryGit(workspace, ["add", "--", "selected.txt", "other.txt"]);
  await repositoryGit(workspace, ["commit", "-m", "test: initial"]);
  await repositoryGit(dir, ["init", "--bare", remote]);
  await repositoryGit(workspace, ["remote", "add", "origin", remote]);
  await repositoryGit(workspace, ["push", "origin", "HEAD:refs/heads/main"]);
  const handle = openDatabase(":memory:");
  databases.push(handle);
  const grants = new RemoteGrantStore(handle.raw, "cloud");
  grants.put({
    ...scope,
    capabilities: ["project.read", "git.preview", "git.commit", "git.push", "approval.resolve"],
    connectionEpoch: 1,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const operations = new RemoteOperationStore(handle.raw);
  const approvals = new ApprovalService(handle.db, new EventHub());
  const remoteApprovals = new RemoteApprovalService(handle.raw, approvals);
  const locks = new RepositoryLockManager();
  const service = new RepositoryOperationService({
    grants,
    operations,
    approvals,
    remoteApprovals,
    resolveWorkspace: () => workspace,
    locks,
    allowLocalRemotes: true,
  });
  async function previewCommit(files = ["selected.txt"]) {
    const input = {
      clientRequestId: randomUUID(),
      kind: "commit" as const,
      files,
      message: "fix: selected change",
    };
    const result = await service.preview(command("git.preview", input), input);
    return result.operation.result as RepositoryPreview;
  }
  async function previewPush() {
    const input = {
      clientRequestId: randomUUID(),
      kind: "push" as const,
      remote: "origin",
      ref: "refs/heads/main",
    };
    return (await service.preview(command("git.preview", input), input)).operation
      .result as RepositoryPreview;
  }
  function approve(preview: RepositoryPreview): RepositoryExecuteInput {
    remoteApprovals.resolve(scope, preview.approvalId, {
      clientRequestId: randomUUID(),
      version: preview.version,
      actionDigest: preview.actionDigest,
      approved: true,
    });
    return {
      clientRequestId: randomUUID(),
      previewId: preview.previewId,
      approvalId: preview.approvalId,
      version: preview.version,
      actionDigest: preview.actionDigest,
    };
  }
  return {
    dir,
    workspace,
    remote,
    service,
    operations,
    grants,
    locks,
    previewCommit,
    previewPush,
    approve,
    handle,
  };
}

describe("scoped repository operations", () => {
  it("commits selected changes once, preserves unrelated work and requires a separate push approval", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "selected change\n");
    await writeFile(join(f.workspace, "other.txt"), "unrelated work\n");
    const indexBefore = await readFile(join(f.workspace, ".git/index"));
    const preview = await f.previewCommit();
    expect(preview.diff).toContain("selected change");
    expect(preview.diff).not.toContain("unrelated work");
    expect(await readFile(join(f.workspace, ".git/index"))).toEqual(indexBefore);
    const input = f.approve(preview);
    const result = await f.service.commit(command("git.commit", input), input);
    expect(result.operation.status).toBe("succeeded");
    const sha = await gitValue(f.workspace, ["rev-parse", "HEAD"]);
    expect((await f.service.commit(command("git.commit", input), input)).replayed).toBe(true);
    expect(await gitValue(f.workspace, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await gitValue(f.workspace, ["show", "HEAD:other.txt"])).toBe("original");
    expect(await gitValue(f.workspace, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await gitValue(f.workspace, ["diff", "--name-only"])).toBe("other.txt");
    await repositoryGit(f.workspace, ["config", "push.followTags", "true"]);
    await repositoryGit(f.workspace, [
      "tag",
      "-a",
      "private-review",
      "-m",
      "not approved for upload",
    ]);
    const pushPreview = await f.previewPush();
    expect(pushPreview.approvalId).not.toBe(preview.approvalId);
    expect(pushPreview.commits).toEqual([{ sha, subject: "fix: selected change" }]);
    const pushInput = f.approve(pushPreview);
    expect((await f.service.push(command("git.push", pushInput), pushInput)).operation.status).toBe(
      "succeeded",
    );
    expect(await gitValue(f.remote, ["rev-parse", "refs/heads/main"])).toBe(sha);
    expect(
      (
        await repositoryGit(f.remote, ["show-ref", "--verify", "refs/tags/private-review"], {
          allowFailure: true,
        })
      ).code,
    ).not.toBe(0);
  });

  it("refuses unselected staged files without modifying the original index", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    await writeFile(join(f.workspace, "other.txt"), "staged by another terminal\n");
    await repositoryGit(f.workspace, ["add", "--", "other.txt"]);
    const index = await readFile(join(f.workspace, ".git/index"));
    await expect(f.previewCommit()).rejects.toThrow("Unselected files");
    expect(await readFile(join(f.workspace, ".git/index"))).toEqual(index);
    expect(await gitValue(f.workspace, ["diff", "--cached", "--name-only"])).toBe("other.txt");
  });

  it("lists staged, unstaged, untracked, deleted and renamed paths for file selection", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "staged version\n");
    await repositoryGit(f.workspace, ["add", "--", "selected.txt"]);
    await writeFile(join(f.workspace, "selected.txt"), "unstaged version\n");
    await writeFile(join(f.workspace, "new file.txt"), "new\n");
    await rm(join(f.workspace, "other.txt"));
    const request = { clientRequestId: randomUUID() };
    const status = await f.service.status(command("project.read", request), request);
    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "selected.txt", indexStatus: "M", worktreeStatus: "M" }),
    );
    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "new file.txt", kind: "untracked" }),
    );
    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "other.txt", kind: "deleted" }),
    );
  });

  it("preserves rename source names and validates the complete routed status payload", async () => {
    const f = await fixture();
    await repositoryGit(f.workspace, ["mv", "--", "selected.txt", "renamed file.txt"]);
    const request = { kind: "git-status" as const, clientRequestId: randomUUID() };
    const status = await f.service.status(command("project.read", request), request);
    expect(status.files).toContainEqual(
      expect.objectContaining({
        path: "renamed file.txt",
        previousPath: "selected.txt",
        kind: "renamed",
      }),
    );
    const tampered = command("project.read", request);
    tampered.payloadHash = payloadDigest({ clientRequestId: request.clientRequestId });
    await expect(f.service.status(tampered, request)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("keeps simultaneous retries attached to a single running commit", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const input = f.approve(await f.previewCommit());
    const results = await Promise.all([
      f.service.commit(command("git.commit", input), input),
      f.service.commit(command("git.commit", input), input),
    ]);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(f.operations.get(scope, results[0]!.operation.operationId)?.status).toBe("succeeded");
    expect(await gitValue(f.workspace, ["rev-list", "--count", "HEAD"])).toBe("2");
  });

  it("rejects changes after approval, expired grants and mismatched approval identities", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "reviewed\n");
    const preview = await f.previewCommit();
    const input = f.approve(preview);
    await writeFile(join(f.workspace, "selected.txt"), "changed after approval\n");
    await expect(f.service.commit(command("git.commit", input), input)).rejects.toMatchObject({
      code: "STALE_PREVIEW",
    });
    const next = await f.previewCommit();
    const wrong = { ...f.approve(next), approvalId: preview.approvalId };
    await expect(f.service.commit(command("git.commit", wrong), wrong)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    f.grants.revoke(scope);
    const retry = { ...input, clientRequestId: randomUUID() };
    await expect(f.service.commit(command("git.commit", retry), retry)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("detects remote target changes and rejects stale recent authentication for push", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const commit = f.approve(await f.previewCommit());
    await f.service.commit(command("git.commit", commit), commit);
    const push = f.approve(await f.previewPush());
    const oldAuth = command("git.push", push);
    oldAuth.actor.recentAuthAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await expect(f.service.push(oldAuth, push)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await repositoryGit(f.workspace, ["remote", "set-url", "origin", join(f.dir, "other.git")]);
    await expect(f.service.push(command("git.push", push), push)).rejects.toMatchObject({
      code: "STALE_PREVIEW",
    });
  });

  it("refuses push when the reviewed remote branch moves", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const commit = f.approve(await f.previewCommit());
    await f.service.commit(command("git.commit", commit), commit);
    const push = f.approve(await f.previewPush());
    await repositoryGit(f.workspace, ["push", "origin", "HEAD:refs/heads/main"]);
    await expect(f.service.push(command("git.push", push), push)).rejects.toMatchObject({
      code: "STALE_PREVIEW",
    });
  });

  it("supports literal leading-dash file names, deletions and binary changes", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "-leading.bin"), Buffer.from([0, 1, 255, 0]));
    await rm(join(f.workspace, "selected.txt"));
    const preview = await f.previewCommit(["-leading.bin", "selected.txt"]);
    expect(preview.diff).toContain("GIT binary patch");
    const input = f.approve(preview);
    expect((await f.service.commit(command("git.commit", input), input)).operation.status).toBe(
      "succeeded",
    );
    expect(await gitValue(f.workspace, ["ls-tree", "--name-only", "HEAD"])).toContain(
      "-leading.bin",
    );
    expect(await gitValue(f.workspace, ["ls-tree", "--name-only", "HEAD"])).not.toContain(
      "selected.txt",
    );
  });

  it("preserves failed hooks and reconciles without repeating commit", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const hookPath = join(f.workspace, ".git/hooks/pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const input = f.approve(await f.previewCommit());
    const before = await gitValue(f.workspace, ["rev-parse", "HEAD"]);
    const index = await readFile(join(f.workspace, ".git/index"));
    const result = await f.service.commit(command("git.commit", input), input);
    expect(result.operation.status).toBe("needs_reconciliation");
    expect(await gitValue(f.workspace, ["rev-parse", "HEAD"])).toBe(before);
    expect(await readFile(join(f.workspace, ".git/index"))).toEqual(index);
    expect((await f.service.reconcile(scope, result.operation.operationId)).status).toBe("failed");
    expect((await f.service.commit(command("git.commit", input), input)).replayed).toBe(true);
  });

  it("honors host global hooks and configured commit signing", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const hookDir = join(f.dir, "host-hooks");
    await mkdir(hookDir);
    await writeFile(join(hookDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const globalConfig = join(f.dir, "global.gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n\thooksPath = ${JSON.stringify(hookDir.replaceAll("\\", "/"))}\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    const before = await gitValue(f.workspace, ["rev-parse", "HEAD"]);
    const input = f.approve(await f.previewCommit());
    expect((await f.service.commit(command("git.commit", input), input)).operation.status).toBe(
      "needs_reconciliation",
    );
    expect(await gitValue(f.workspace, ["rev-parse", "HEAD"])).toBe(before);
    await writeFile(join(hookDir, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await repositoryGit(f.workspace, ["config", "commit.gpgsign", "true"]);
    await repositoryGit(f.workspace, [
      "config",
      "gpg.program",
      join(f.dir, "missing-signing-program"),
    ]);
    const signed = f.approve(await f.previewCommit());
    expect((await f.service.commit(command("git.commit", signed), signed)).operation.status).toBe(
      "needs_reconciliation",
    );
    expect(await gitValue(f.workspace, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("keeps hook-modified commits uncertain until the actual tree is reviewed", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "reviewed\n");
    const index = await readFile(join(f.workspace, ".git/index"));
    await writeFile(
      join(f.workspace, ".git/hooks/pre-commit"),
      "#!/bin/sh\nprintf 'hook modification\\n' > other.txt\ngit add -- other.txt\n",
      { mode: 0o755 },
    );
    const input = f.approve(await f.previewCommit());
    const result = await f.service.commit(command("git.commit", input), input);
    expect(result.operation.status).toBe("needs_reconciliation");
    expect(await gitValue(f.workspace, ["show", "HEAD:other.txt"])).toBe("hook modification");
    expect(await readFile(join(f.workspace, ".git/index"))).toEqual(index);
    expect((await f.service.reconcile(scope, result.operation.operationId)).status).toBe(
      "needs_reconciliation",
    );
    expect((await f.service.commit(command("git.commit", input), input)).replayed).toBe(true);
  });

  it("terminates the hook process tree before returning a Git timeout", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    await repositoryGit(f.workspace, ["add", "--", "selected.txt"]);
    const pidPath = join(f.dir, "hook-pids.json");
    const script = join(f.dir, "long-hook.cjs");
    await writeFile(
      script,
      `
      const {spawn}=require('node:child_process');
      const {writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));
      setInterval(()=>{},1000);
    `,
    );
    await writeFile(
      join(f.workspace, ".git/hooks/pre-commit"),
      `#!/bin/sh\n"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"\n`,
      { mode: 0o755 },
    );
    const result = await repositoryGit(f.workspace, ["commit", "-m", "test: timeout"], {
      timeoutMs: 5000,
      allowFailure: true,
    });
    expect(result.code).toBe(-1);
    const pids = JSON.parse(await readFile(pidPath, "utf8")) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(await gitValue(f.workspace, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("reconciles completed Git side effects after result persistence fails without replaying them", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "selected.txt"), "new\n");
    const input = f.approve(await f.previewCommit());
    const transition = f.operations.transition.bind(f.operations);
    let dropResult = true;
    const spy = vi
      .spyOn(f.operations, "transition")
      .mockImplementation((scope, id, status, result) => {
        if (dropResult && status === "succeeded") {
          dropResult = false;
          throw new Error("Simulated lost result");
        }
        return transition(scope, id, status, result);
      });
    const commit = await f.service.commit(command("git.commit", input), input);
    expect(commit.operation.status).toBe("needs_reconciliation");
    const sha = await gitValue(f.workspace, ["rev-parse", "HEAD"]);
    expect((await f.service.reconcile(scope, commit.operation.operationId)).status).toBe(
      "succeeded",
    );
    expect((await f.service.commit(command("git.commit", input), input)).replayed).toBe(true);
    expect(await gitValue(f.workspace, ["rev-parse", "HEAD"])).toBe(sha);
    spy.mockRestore();
    const pushInput = f.approve(await f.previewPush());
    dropResult = true;
    vi.spyOn(f.operations, "transition").mockImplementation((scope, id, status, result) => {
      if (dropResult && status === "succeeded") {
        dropResult = false;
        throw new Error("Simulated lost push result");
      }
      return transition(scope, id, status, result);
    });
    const push = await f.service.push(command("git.push", pushInput), pushInput);
    expect(push.operation.status).toBe("needs_reconciliation");
    expect(await gitValue(f.remote, ["rev-parse", "refs/heads/main"])).toBe(sha);
    expect((await f.service.reconcile(scope, push.operation.operationId)).status).toBe("succeeded");
    expect((await f.service.push(command("git.push", pushInput), pushInput)).replayed).toBe(true);
  });

  it("serializes shared repository writes across independent service instances", async () => {
    const f = await fixture();
    const another = new RepositoryLockManager();
    const linked = join(f.dir, "linked");
    await repositoryGit(f.workspace, ["worktree", "add", "-b", "linked", linked]);
    await f.locks.withLock(f.workspace, "run-one", async () => {
      await expect(
        another.withLock(f.workspace, "run-two", async () => true),
      ).rejects.toMatchObject({ code: "REPO_BUSY" });
      await expect(another.withLock(linked, "run-linked", async () => true)).rejects.toMatchObject({
        code: "REPO_BUSY",
      });
    });
    expect(await another.withLock(f.workspace, "run-three", async () => true)).toBe(true);
  });
});

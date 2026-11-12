import { execFileSync } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SnapshotManifest } from "@agentdesk/shared";
import { openDatabase } from "../src/db/client";
import { WorkspaceTransferService } from "../src/services/workspace-transfer/service";
import { RepositoryLockManager } from "../src/services/remote/repository-locks";
import type { ProjectService } from "../src/services/projects";
import { CloudRepositorySetup } from "../src/services/remote/repository-setup";
import { SecretStore } from "../src/secrets";
import type * as RepositoryGitModule from "../src/services/remote/repository-git";
const fetchTransport = vi.hoisted(() => ({ remote: "" }));
vi.mock("../src/services/remote/repository-git", async (original) => {
  const actual = await original<typeof RepositoryGitModule>();
  return {
    ...actual,
    repositoryGit: (
      cwd: string,
      args: string[],
      options: Parameters<typeof actual.repositoryGit>[2],
    ) =>
      actual.repositoryGit(
        cwd,
        args.includes("fetch")
          ? args.map((arg) =>
              arg === "https://github.com/owner/repository.git" ? fetchTransport.remote : arg,
            )
          : args,
        options,
      ),
  };
});
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-transfer-")),
    source = join(root, "source"),
    cloudRoot = join(root, "cloud");
  mkdirSync(source);
  mkdirSync(cloudRoot);
  const destination = join(cloudRoot, "original");
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Snapshot Test");
  git(source, "config", "user.email", "snapshot@test.invalid");
  writeFileSync(join(source, "code.txt"), "original\n");
  writeFileSync(join(source, "deleted.txt"), "delete me\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "chore: initial");
  git(root, "clone", "--no-hardlinks", source, destination);
  const db = openDatabase(":memory:");
  let registered = "";
  const projects = {
    add: async (path: string) => {
      registered = path;
      return { id: "recovery-project" };
    },
  } as unknown as ProjectService;
  const locks = new RepositoryLockManager(),
    scope = { userId: "owner", hostId: "office", projectId: "project", workspaceId: "project" },
    target = { ...scope, hostId: "cloud" };
  const service = new WorkspaceTransferService(
    db.raw,
    join(root, "storage"),
    async (s) => (s.hostId === "office" ? source : destination),
    locks,
    projects,
    cloudRoot,
  );
  return {
    root,
    source,
    destination,
    scope,
    target,
    service,
    db,
    recovered: () => registered,
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function manifestFor(f: ReturnType<typeof fixture>, snapshotId: string) {
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const chunk = await f.service.chunk(f.scope, {
      kind: "chunk",
      snapshotId,
      file: "manifest",
      offset,
    });
    const bytes = Buffer.from(chunk.data, "base64");
    expect(hash(bytes)).toBe(chunk.sha256);
    parts.push(bytes);
    offset += bytes.length;
    if (offset === chunk.total) break;
  } while (offset > 0);
  const text = Buffer.concat(parts).toString("utf8");
  return { manifest: SnapshotManifest.parse(JSON.parse(text)), manifestDigest: hash(text) };
}
it("captures selected changes and binaries, resumes verified chunks, imports into a new exact-base workspace and preserves source/index", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, "code.txt"), "staged\n");
    git(f.source, "add", "code.txt");
    writeFileSync(join(f.source, "code.txt"), "unstaged final\n");
    rmSync(join(f.source, "deleted.txt"));
    writeFileSync(join(f.source, "binary.dat"), Buffer.alloc(130000, 0x99));
    writeFileSync(join(f.source, ".env"), "SECRET=not transferred");
    writeFileSync(join(f.source, "unselected.txt"), "untouched");
    const before = git(f.source, "status", "--porcelain"),
      index = git(f.source, "write-tree"),
      head = git(f.source, "rev-parse", "HEAD");
    const input = {
      clientRequestId: randomUUID(),
      files: ["code.txt", "deleted.txt", "binary.dat", ".env"],
    };
    const captured = await f.service.capture(f.scope, input);
    expect(await f.service.capture(f.scope, input)).toEqual(captured);
    await expect(
      f.service.capture(f.scope, { ...input, files: ["code.txt"] }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const manifest = await manifestFor(f, captured.snapshotId);
    expect(manifest.manifest.sourceHead).toBe(head);
    expect(manifest.manifest.exclusions.map((e) => e.path)).toEqual([".env"]);
    const begun = await f.service.begin(f.target, {
      kind: "begin",
      clientRequestId: randomUUID(),
      ...manifest,
    });
    await expect(
      f.service.import(f.target, {
        kind: "import",
        transferId: begun.id,
        manifestDigest: manifest.manifestDigest,
      }),
    ).rejects.toThrow();
    expect(f.recovered()).toBe("");
    for (let i = 0; i < manifest.manifest.entries.length; i++) {
      const entry = manifest.manifest.entries[i]!;
      if (entry.kind !== "file") continue;
      for (let offset = 0; offset < entry.size;) {
        const chunk = await f.service.chunk(f.scope, {
          kind: "chunk",
          snapshotId: captured.snapshotId,
          file: i,
          offset,
        });
        const upload = {
          kind: "upload",
          transferId: begun.id,
          file: i,
          offset,
          data: chunk.data,
          sha256: chunk.sha256,
        };
        await f.service.upload(f.target, upload);
        await f.service.upload(f.target, upload);
        offset += Buffer.from(chunk.data, "base64").length;
      }
    }
    const imported = await f.service.import(f.target, {
      kind: "import",
      transferId: begun.id,
      manifestDigest: manifest.manifestDigest,
    });
    expect(imported.status).toBe("verified");
    expect(git(f.recovered(), "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(f.recovered(), "code.txt"), "utf8")).toBe("unstaged final\n");
    expect(readFileSync(join(f.recovered(), "binary.dat"))).toEqual(Buffer.alloc(130000, 0x99));
    expect(existsSync(join(f.recovered(), "deleted.txt"))).toBe(false);
    expect(existsSync(join(f.recovered(), ".env"))).toBe(false);
    expect(git(f.source, "status", "--porcelain")).toBe(before);
    expect(git(f.source, "write-tree")).toBe(index);
    expect(git(f.destination, "status", "--porcelain")).toBe("");
    await expect(
      f.service.chunk(
        { ...f.scope, userId: "stranger" },
        { kind: "chunk", snapshotId: captured.snapshotId, file: 0, offset: 0 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    f.dispose();
  }
}, 30000);
it("rejects a missing source commit, invalid chunk bytes and unsafe snapshot paths", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, "code.txt"), "unpublished commit\n");
    git(f.source, "add", "code.txt");
    git(f.source, "commit", "-m", "fix: local only");
    writeFileSync(join(f.source, "code.txt"), "next change\n");
    await expect(
      f.service.capture(f.scope, { clientRequestId: randomUUID(), files: ["../outside"] }),
    ).rejects.toThrow();
    const captured = await f.service.capture(f.scope, {
      clientRequestId: randomUUID(),
      files: ["code.txt"],
    });
    const manifest = await manifestFor(f, captured.snapshotId);
    await expect(
      f.service.begin(f.target, { kind: "begin", clientRequestId: randomUUID(), ...manifest }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_BASE_MISSING" });
    git(f.destination, "fetch", "origin");
    const begun = await f.service.begin(f.target, {
      kind: "begin",
      clientRequestId: randomUUID(),
      ...manifest,
    });
    await expect(
      f.service.upload(f.target, {
        kind: "upload",
        transferId: begun.id,
        file: 0,
        offset: 0,
        data: Buffer.from("bad").toString("base64"),
        sha256: hash("bad"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    f.dispose();
  }
}, 30000);
it("cleans expired temporary snapshots on schedule without deleting the workspace", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, "code.txt"), "changed\n");
    const snapshot = await f.service.capture(f.scope, {
      clientRequestId: randomUUID(),
      files: ["code.txt"],
    });
    f.db.raw
      .prepare("UPDATE workspace_snapshots SET created_at=? WHERE id=?")
      .run(Date.now() - 90000000, snapshot.snapshotId);
    const temporary = join(f.root, "storage", "snapshots", snapshot.snapshotId);
    expect(existsSync(temporary)).toBe(true);
    vi.useFakeTimers();
    await f.service.startCleanup(1000);
    await f.service.cleanup();
    expect(existsSync(temporary)).toBe(false);
    expect(
      f.db.raw
        .prepare("SELECT status FROM workspace_snapshots WHERE id=?")
        .get(snapshot.snapshotId),
    ).toEqual({ status: "expired" });
    expect(readFileSync(join(f.source, "code.txt"), "utf8")).toBe("changed\n");
    expect(vi.getTimerCount()).toBe(1);
    await f.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await f.service.dispose();
    f.dispose();
  }
}, 30000);
it("recovers an unpublished base after explicit temporary-branch push and cloud fetch", async () => {
  const f = fixture();
  try {
    const remote = join(f.root, "remote.git");
    git(f.root, "clone", "--bare", f.source, remote);
    writeFileSync(join(f.source, "code.txt"), "unpublished base\n");
    git(f.source, "add", "code.txt");
    git(f.source, "commit", "-m", "fix: unpublished base");
    const head = git(f.source, "rev-parse", "HEAD");
    writeFileSync(join(f.source, "code.txt"), "changes after local commit\n");
    const snapshot = await f.service.capture(f.scope, {
      clientRequestId: randomUUID(),
      files: ["code.txt"],
    });
    const manifest = await manifestFor(f, snapshot.snapshotId);
    const input = { kind: "begin", clientRequestId: randomUUID(), ...manifest };
    await expect(f.service.begin(f.target, input)).rejects.toMatchObject({
      code: "SNAPSHOT_BASE_MISSING",
    });
    git(f.source, "push", remote, "HEAD:refs/heads/agentdesk-transfer-test");
    git(f.destination, "remote", "set-url", "origin", "https://github.com/owner/repository.git");
    fetchTransport.remote = remote;
    const setup = new CloudRepositorySetup(
      f.db.raw,
      new SecretStore(f.db.db, randomBytes(32).toString("base64"), f.root),
      {} as ProjectService,
      f.root,
      join(f.root, "cloud"),
    );
    const before = git(f.destination, "rev-parse", "HEAD");
    await expect(setup.fetchBase(f.destination, "refs/heads/../bad")).rejects.toThrow();
    expect(await setup.fetchBase(f.destination, "refs/heads/agentdesk-transfer-test")).toEqual({
      fetched: true,
      head,
    });
    expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    expect(git(f.destination, "status", "--porcelain")).toBe("");
    const transfer = await f.service.begin(f.target, input);
    const chunk = await f.service.chunk(f.scope, {
      kind: "chunk",
      snapshotId: snapshot.snapshotId,
      file: 0,
      offset: 0,
    });
    await f.service.upload(f.target, {
      kind: "upload",
      transferId: transfer.id,
      file: 0,
      offset: 0,
      data: chunk.data,
      sha256: chunk.sha256,
    });
    expect(
      (
        await f.service.import(f.target, {
          kind: "import",
          transferId: transfer.id,
          manifestDigest: manifest.manifestDigest,
        })
      ).status,
    ).toBe("verified");
    expect(git(f.recovered(), "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(f.recovered(), "code.txt"), "utf8")).toBe(
      "changes after local commit\n",
    );
    expect(git(f.source, "status", "--porcelain")).toContain("code.txt");
    await setup.dispose();
  } finally {
    f.dispose();
  }
}, 30000);

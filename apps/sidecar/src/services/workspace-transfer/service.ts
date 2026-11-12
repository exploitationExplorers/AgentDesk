import { businessDatabase, type BusinessDatabase } from "../../db/business-database";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  SnapshotManifest,
  SnapshotPath,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_FILE_BYTES,
  RemoteId,
  type RemoteScope,
  type SnapshotEntry,
} from "@agentdesk/shared";
import { gitValue, repositoryGit } from "../remote/repository-git";
import { payloadDigest } from "../remote/digest";
import type { RepositoryLockManager } from "../remote/repository-locks";
import type { ProjectService } from "../projects";
const CHUNK = 48 * 1024;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const excluded = (path: string) =>
  path
    .split("/")
    .some(
      (segment) =>
        /^(\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.agentdesk|node_modules|\.cache|dist|build|coverage|id_rsa|id_ed25519)$/i.test(
          segment,
        ) || /\.(pem|key|p12|pfx)$/i.test(segment),
    );
interface SnapshotRow {
  id: string;
  user_id: string;
  host_id: string;
  project_id: string;
  payload_hash: string;
  status: string;
  manifest_json: string | null;
  created_at: number;
}
interface TransferRow {
  id: string;
  user_id: string;
  host_id: string;
  project_id: string;
  manifest_json: string;
  manifest_hash: string;
  status: string;
  result_json: string | null;
  created_at: number;
}
const currentState = async (workspace: string) => ({
  head: await gitValue(workspace, ["rev-parse", "HEAD"]),
  indexTree: await gitValue(workspace, ["write-tree"]),
  branch: await gitValue(workspace, ["symbolic-ref", "--short", "HEAD"]),
  status: (
    await repositoryGit(workspace, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ])
  ).stdout,
});
export class WorkspaceTransferService {
  private readonly db: BusinessDatabase;
  readonly ready: Promise<void>;
  private readonly active = new Set<string>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleaning?: Promise<void>;
  async startCleanup(intervalMs = 60 * 60000) {
    if (this.cleanupTimer) return;
    const sweep = async () =>
      void this.cleanup().catch(() =>
        console.warn("[workspace-transfer] Temporary storage cleanup failed"),
      );
    this.cleanupTimer = setInterval(sweep, intervalMs);
    this.cleanupTimer.unref();
    await sweep();
  }
  async dispose() {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await this.ready;
    await this.cleaning;
  }
  constructor(
    db: Database.Database | BusinessDatabase,
    private readonly directory: string,
    private readonly resolveWorkspace: (scope: RemoteScope) => Promise<string>,
    private readonly locks: RepositoryLockManager,
    private readonly projects: ProjectService,
    private readonly workspaceRoot: string,
  ) {
    this.db = businessDatabase(db);
    this.ready = Promise.resolve().then(async () => {
      // 重启后无法证明未完成导入的完整性，保留现场供核对。
      await this.db
        .prepare("UPDATE workspace_transfers SET status='failed' WHERE status='importing'")
        .run();
      await this.db
        .prepare("UPDATE workspace_snapshots SET status='failed' WHERE status='capturing'")
        .run();
    });
  }
  private async initialize() {
    await this.ready;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  private async quota(bytes: number) {
    await this.initialize();
    await this.cleanup();
    const disk = await statfs(this.directory);
    await this.checkQuota();
    if (disk.bavail * disk.bsize < bytes + 128 * 1024 * 1024)
      throw new AppError(ErrorCode.TransferQuotaExceeded, "Snapshot storage disk reserve exceeded");
  }
  private async checkQuota() {
    const count = (
      (await this.db
        .prepare(
          "SELECT (SELECT count(*) FROM workspace_snapshots WHERE status!='expired')+(SELECT count(*) FROM workspace_transfers WHERE created_at>?) AS count",
        )
        .get(Date.now() - 86400000)) as {
        count: number;
      }
    ).count;
    if (count >= 32)
      throw new AppError(
        ErrorCode.TransferQuotaExceeded,
        "Snapshot storage quota or disk reserve exceeded",
      );
  }
  /** 仅回收私有暂存目录，已恢复的工作区与幂等记录继续保留。 */
  async cleanup(): Promise<void> {
    await this.ready;
    return (this.cleaning ??= this.sweep().finally(() => {
      this.cleaning = undefined;
    }));
  }
  private async sweep() {
    for (const [table, folder] of [
      ["workspace_snapshots", "snapshots"],
      ["workspace_transfers", "transfers"],
    ] as const) {
      const rows = (await this.db
        .prepare(`SELECT id,status FROM ${table} WHERE created_at<? AND status!='expired'`)
        .all(Date.now() - 86400000)) as {
        id: string;
        status: string;
      }[];
      for (const row of rows) {
        if (this.active.has(row.id)) continue;
        const root = resolve(this.directory, folder),
          path = resolve(root, RemoteId.parse(row.id));
        if (relative(root, path) !== row.id) throw new Error("Invalid temporary storage path");
        // 所有目标由服务生成；不遍历 workspaces，也不拼接用户文件名。
        await rm(path, { recursive: true, force: true });
        if (row.status !== "verified")
          await this.db.prepare(`UPDATE ${table} SET status='expired' WHERE id=?`).run(row.id);
      }
    }
  }
  private async own<T extends SnapshotRow | TransferRow>(
    table: "workspace_snapshots" | "workspace_transfers",
    scope: RemoteScope,
    id: string,
  ): Promise<T> {
    RemoteId.parse(id);
    const row = (await this.db
      .prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=? AND host_id=? AND project_id=?`)
      .get(id, scope.userId, scope.hostId, scope.projectId)) as T | undefined;
    if (!row) throw new AppError(ErrorCode.NotFound, "Snapshot or transfer not found");
    if (Date.now() - row.created_at > 86400000 && row.status !== "verified")
      throw new AppError(ErrorCode.Conflict, "Snapshot or transfer expired");
    return row;
  }
  private async file(workspace: string, path: string, allowMissing = false) {
    SnapshotPath.parse(path);
    const root = await realpath(workspace);
    let cursor = root;
    for (const segment of path.split("/")) {
      cursor = join(cursor, segment);
      try {
        const s = await lstat(cursor);
        if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
          throw new AppError(
            ErrorCode.Forbidden,
            "Symlinks and special files require separate handling",
          );
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    const target = resolve(root, path),
      rel = relative(root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..")
      throw new AppError(ErrorCode.Forbidden, "Snapshot path escapes workspace");
    return target;
  }
  private async readBounded(path: string) {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > SNAPSHOT_MAX_FILE_BYTES)
        throw new AppError(ErrorCode.TransferQuotaExceeded, "Selected file is too large");
      const bytes = Buffer.alloc(stat.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, bytes.length - read, read);
        if (!next.bytesRead) break;
        read += next.bytesRead;
      }
      if (read !== stat.size)
        throw new AppError(ErrorCode.StalePreview, "File changed during capture");
      return { bytes: bytes.subarray(0, read), stat };
    } finally {
      await handle.close();
    }
  }
  async capture(scope: RemoteScope, raw: unknown) {
    const input = z
      .strictObject({
        clientRequestId: RemoteId,
        files: z.array(SnapshotPath).min(1).max(SNAPSHOT_MAX_FILES),
      })
      .parse(raw);
    const digest = payloadDigest(input);
    const old = (await this.db
      .prepare(
        "SELECT * FROM workspace_snapshots WHERE user_id=? AND host_id=? AND project_id=? AND request_id=?",
      )
      .get(scope.userId, scope.hostId, scope.projectId, input.clientRequestId)) as
      SnapshotRow | undefined;
    if (old) {
      if (old.payload_hash !== digest)
        throw new AppError(ErrorCode.IdempotencyConflict, "Snapshot request changed");
      if (old.status !== "ready")
        throw new AppError(
          ErrorCode.Conflict,
          "Previous snapshot is incomplete; inspect it before creating a new request",
        );
      return await this.describe(scope, old.id);
    }
    await this.quota(SNAPSHOT_MAX_BYTES);
    const workspace = await this.resolveWorkspace(scope),
      id = randomUUID();
    await this.checkQuota();
    await this.db
      .prepare("INSERT INTO workspace_snapshots VALUES(?,?,?,?,?,?,'capturing',NULL,?)")
      .run(
        id,
        scope.userId,
        scope.hostId,
        scope.projectId,
        input.clientRequestId,
        digest,
        Date.now(),
      );
    this.active.add(id);
    try {
      return await this.locks.withLock(workspace, id, async () => {
        const before = await currentState(workspace),
          status = new Map<string, string>();
        for (const row of before.status.split("\0").filter(Boolean))
          status.set(row.slice(3), row.slice(0, 2));
        const entries: SnapshotEntry[] = [],
          exclusions: {
            path: string;
            reason: string;
          }[] = [];
        const directory = join(this.directory, "snapshots", id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let bytes = 0;
        for (const path of [...new Set(input.files)].sort()) {
          if (excluded(path)) {
            exclusions.push({
              path,
              reason: "Sensitive configuration, credential, dependency or build output",
            });
            continue;
          }
          const state = status.get(path);
          if (!state || state.includes("U") || state === "AA" || state === "DD")
            throw new AppError(ErrorCode.Conflict, "Selected path is unchanged or conflicted");
          const index = (await repositoryGit(workspace, ["ls-files", "--stage", "--", path]))
            .stdout;
          if (
            index.startsWith("120000 ") ||
            index.startsWith("160000 ") ||
            (await gitValue(workspace, ["check-attr", "filter", "--", path])).endsWith(": lfs")
          )
            throw new AppError(
              ErrorCode.Conflict,
              "Symlink, submodule or LFS content requires separate handling",
            );
          const sourceStatus =
            state === "??"
              ? "untracked"
              : state[0] !== " " && state[1] !== " "
                ? "both"
                : state[0] !== " "
                  ? "staged"
                  : "unstaged";
          const full = await this.file(workspace, path, true);
          let content: Awaited<ReturnType<WorkspaceTransferService["readBounded"]>>;
          try {
            content = await this.readBounded(full);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code === "ENOENT" &&
              sourceStatus !== "untracked"
            ) {
              entries.push({ path, kind: "deleted", sourceStatus });
              continue;
            }
            throw error;
          }
          bytes += content.bytes.length;
          if (bytes > SNAPSHOT_MAX_BYTES)
            throw new AppError(ErrorCode.TransferQuotaExceeded, "Snapshot exceeds quota");
          const sha256 = hash(content.bytes);
          await writeFile(join(directory, sha256), content.bytes, { mode: 0o600 });
          entries.push({
            path,
            kind: "file",
            sourceStatus,
            size: content.bytes.length,
            sha256,
            executable:
              process.platform === "win32"
                ? index.startsWith("100755 ")
                : Boolean(content.stat.mode & 0o111),
          });
        }
        const manifest = SnapshotManifest.parse({
          version: 1,
          snapshotId: id,
          sourceHostId: scope.hostId,
          sourceProjectId: scope.projectId,
          sourceWorkspaceId: scope.workspaceId,
          repositoryIdentity: `git-root:${await gitValue(workspace, ["rev-list", "--max-parents=0", "HEAD"])}`,
          sourceHead: before.head,
          indexTree: before.indexTree,
          branch: before.branch,
          capturedAt: new Date().toISOString(),
          entries,
          exclusions,
        });
        for (const entry of entries) {
          const path = await this.file(workspace, entry.path, true);
          if (entry.kind === "file") {
            if (hash((await this.readBounded(path)).bytes) !== entry.sha256)
              throw new AppError(ErrorCode.StalePreview, "Source changed during snapshot capture");
          } else {
            try {
              await lstat(path);
              throw new AppError(ErrorCode.StalePreview, "Deleted file reappeared");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        }
        if (payloadDigest(before) !== payloadDigest(await currentState(workspace)))
          throw new AppError(ErrorCode.StalePreview, "Repository changed during snapshot capture");
        const text = JSON.stringify(manifest);
        await writeFile(join(directory, "manifest.json"), text, { mode: 0o600 });
        await this.db
          .prepare("UPDATE workspace_snapshots SET status='ready',manifest_json=? WHERE id=?")
          .run(text, id);
        return await this.describe(scope, id);
      });
    } catch (error) {
      await this.db.prepare("UPDATE workspace_snapshots SET status='failed' WHERE id=?").run(id);
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
  async describe(scope: RemoteScope, id: string) {
    const row = await this.own<SnapshotRow>("workspace_snapshots", scope, id);
    if (row.status !== "ready" || !row.manifest_json)
      throw new AppError(ErrorCode.Conflict, "Snapshot is not ready");
    return {
      snapshotId: id,
      manifestDigest: hash(row.manifest_json),
      manifestBytes: Buffer.byteLength(row.manifest_json),
      status: row.status,
    };
  }
  async chunk(scope: RemoteScope, raw: unknown) {
    const input = z
      .strictObject({
        kind: z.literal("chunk"),
        snapshotId: RemoteId,
        file: z.union([z.literal("manifest"), z.number().int().min(0)]),
        offset: z.number().int().min(0),
      })
      .parse(raw);
    const row = await this.own<SnapshotRow>("workspace_snapshots", scope, input.snapshotId);
    if (!row.manifest_json || row.status !== "ready")
      throw new AppError(ErrorCode.Conflict, "Snapshot not ready");
    const manifest = SnapshotManifest.parse(JSON.parse(row.manifest_json));
    const entry = typeof input.file === "number" ? manifest.entries[input.file] : undefined;
    if (input.file !== "manifest" && (!entry || entry.kind !== "file"))
      throw new AppError(ErrorCode.NotFound, "Snapshot file not found");
    const name = entry?.kind === "file" ? entry.sha256 : "manifest.json";
    const handle = await open(join(this.directory, "snapshots", row.id, name), "r");
    try {
      const size = (await handle.stat()).size;
      if (input.offset > size || input.offset % CHUNK !== 0)
        throw new AppError(ErrorCode.BadRequest, "Invalid chunk offset");
      const data = Buffer.alloc(Math.min(CHUNK, size - input.offset));
      await handle.read(data, 0, data.length, input.offset);
      return {
        offset: input.offset,
        total: size,
        sha256: hash(data),
        data: data.toString("base64"),
      };
    } finally {
      await handle.close();
    }
  }
  async begin(scope: RemoteScope, raw: unknown) {
    const input = z
      .strictObject({
        kind: z.literal("begin"),
        clientRequestId: RemoteId,
        manifest: SnapshotManifest,
        manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(raw);
    const text = JSON.stringify(input.manifest);
    if (hash(text) !== input.manifestDigest)
      throw new AppError(ErrorCode.BadRequest, "Manifest digest does not match");
    const old = (await this.db
      .prepare(
        "SELECT * FROM workspace_transfers WHERE user_id=? AND host_id=? AND project_id=? AND request_id=?",
      )
      .get(scope.userId, scope.hostId, scope.projectId, input.clientRequestId)) as
      TransferRow | undefined;
    if (old) {
      if (old.manifest_hash !== input.manifestDigest)
        throw new AppError(ErrorCode.IdempotencyConflict, "Transfer request changed");
      return await this.transfer(scope, old.id);
    }
    const workspace = await this.resolveWorkspace(scope);
    const base = await repositoryGit(
      workspace,
      ["cat-file", "-e", `${input.manifest.sourceHead}^{commit}`],
      { allowFailure: true },
    );
    if (base.code !== 0)
      throw new AppError(
        ErrorCode.SnapshotBaseMissing,
        "Exact source commit is missing; explicitly push/fetch the base before import",
      );
    const identity = `git-root:${await gitValue(workspace, ["rev-list", "--max-parents=0", input.manifest.sourceHead])}`;
    if (identity !== input.manifest.repositoryIdentity)
      throw new AppError(
        ErrorCode.Forbidden,
        "Source and destination repository identities differ",
      );
    await this.quota(SNAPSHOT_MAX_BYTES);
    const id = randomUUID();
    await mkdir(join(this.directory, "transfers", id), { recursive: true, mode: 0o700 });
    await this.checkQuota();
    await this.db
      .prepare("INSERT INTO workspace_transfers VALUES(?,?,?,?,?,?,?,'transferring',NULL,?)")
      .run(
        id,
        scope.userId,
        scope.hostId,
        scope.projectId,
        input.clientRequestId,
        text,
        input.manifestDigest,
        Date.now(),
      );
    return await this.transfer(scope, id);
  }
  async transfer(scope: RemoteScope, id: string) {
    const row = await this.own<TransferRow>("workspace_transfers", scope, id);
    return {
      id,
      status: row.status,
      manifest: SnapshotManifest.parse(JSON.parse(row.manifest_json)),
      manifestDigest: row.manifest_hash,
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  }
  async upload(scope: RemoteScope, raw: unknown) {
    const input = z
      .strictObject({
        kind: z.literal("upload"),
        transferId: RemoteId,
        file: z.number().int().min(0),
        offset: z.number().int().min(0),
        data: z.string().max(65536),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(raw);
    const row = await this.own<TransferRow>("workspace_transfers", scope, input.transferId);
    if (row.status !== "transferring" || this.active.has(row.id))
      throw new AppError(ErrorCode.Conflict, "Transfer no longer accepts chunks");
    const entry = SnapshotManifest.parse(JSON.parse(row.manifest_json)).entries[input.file];
    const data = Buffer.from(input.data, "base64");
    if (
      !entry ||
      entry.kind !== "file" ||
      data.length > CHUNK ||
      input.offset % CHUNK !== 0 ||
      input.offset + data.length > entry.size ||
      data.length !== Math.min(CHUNK, entry.size - input.offset) ||
      hash(data) !== input.sha256 ||
      data.toString("base64") !== input.data
    )
      throw new AppError(ErrorCode.BadRequest, "Chunk hash, bounds or file do not match");
    const path = join(this.directory, "transfers", row.id, `${input.file}-${input.offset}`);
    this.active.add(row.id);
    try {
      try {
        await writeFile(path, data, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hash(await readFile(path)) !== input.sha256)
          throw new AppError(ErrorCode.IdempotencyConflict, "Chunk content changed");
      }
    } finally {
      this.active.delete(row.id);
    }
    return { accepted: true, nextOffset: input.offset + data.length };
  }
  async import(scope: RemoteScope, raw: unknown) {
    const input = z
      .strictObject({ kind: z.literal("import"), transferId: RemoteId, manifestDigest: z.string() })
      .parse(raw);
    const row = await this.own<TransferRow>("workspace_transfers", scope, input.transferId);
    if (input.manifestDigest !== row.manifest_hash)
      throw new AppError(ErrorCode.StalePreview, "Manifest changed");
    if (row.status === "verified") return await this.transfer(scope, row.id);
    if (row.status !== "transferring" || this.active.has(row.id))
      throw new AppError(ErrorCode.Conflict, "Transfer requires reconciliation");
    this.active.add(row.id);
    try {
      const manifest = SnapshotManifest.parse(JSON.parse(row.manifest_json)),
        buffers = new Map<string, Buffer>();
      for (let i = 0; i < manifest.entries.length; i++) {
        const entry = manifest.entries[i]!;
        if (entry.kind !== "file") continue;
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < entry.size; offset += CHUNK)
          chunks.push(await readFile(join(this.directory, "transfers", row.id, `${i}-${offset}`)));
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
          throw new AppError(ErrorCode.BadRequest, "Transferred file digest does not match");
        buffers.set(entry.path, bytes);
      }
      const source = await this.resolveWorkspace(scope),
        destination = join(await realpath(this.workspaceRoot), `recovery-${row.id}`);
      return await this.locks.withLock(source, row.id, async () => {
        const tree = (
          await repositoryGit(source, ["ls-tree", "-r", "-z", manifest.sourceHead])
        ).stdout
          .split("\0")
          .filter(Boolean);
        if (tree.some((entry) => /^(120000|160000) /.test(entry)))
          throw new AppError(
            ErrorCode.Conflict,
            "Base contains symlinks or submodules requiring separate handling",
          );
        const paths = (
          await repositoryGit(source, ["ls-tree", "-r", "-z", "--name-only", manifest.sourceHead])
        ).stdout
          .split("\0")
          .filter(Boolean);
        const keys = new Map<string, string>();
        for (const path of [
          ...paths,
          ...manifest.entries.filter((e) => e.kind === "file").map((e) => e.path),
        ]) {
          SnapshotPath.parse(path);
          const previous = keys.get(path.toLowerCase());
          if (previous && previous !== path)
            throw new AppError(
              ErrorCode.Conflict,
              "Case-colliding paths require separate handling",
            );
          keys.set(path.toLowerCase(), path);
        }
        await this.db
          .prepare("UPDATE workspace_transfers SET status='importing' WHERE id=?")
          .run(row.id);
        // 恢复不运行仓库 hooks 或 checkout filters；它们可执行任意本机命令。
        const filters = (
          await repositoryGit(
            source,
            [
              "config",
              "--name-only",
              "--get-regexp",
              "^filter\\..*\\.(smudge|clean|process|required)$",
            ],
            { allowFailure: true },
          )
        ).stdout
          .split("\n")
          .filter(Boolean);
        const safeConfig = [
          "-c",
          "core.hooksPath=",
          "-c",
          "core.autocrlf=false",
          ...filters.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]),
        ];
        await repositoryGit(source, [
          ...safeConfig,
          "worktree",
          "add",
          "-b",
          `recovery/${row.id}`,
          destination,
          manifest.sourceHead,
        ]);
        for (const entry of manifest.entries) {
          const full = await this.file(destination, entry.path, true);
          if (entry.kind === "deleted") {
            const { unlink } = await import("node:fs/promises");
            try {
              await unlink(full);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          } else {
            await mkdir(resolve(full, ".."), { recursive: true });
            await this.file(destination, entry.path, true);
            await writeFile(full, buffers.get(entry.path)!, {
              mode: entry.executable ? 0o755 : 0o644,
            });
            if (process.platform !== "win32") await chmod(full, entry.executable ? 0o755 : 0o644);
          }
        }
        for (const entry of manifest.entries) {
          const path = await this.file(destination, entry.path, true);
          if (entry.kind === "deleted") {
            try {
              await lstat(path);
              throw new AppError(ErrorCode.Conflict, "Recovered deletion does not match manifest");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          } else {
            const content = await this.readBounded(path);
            if (
              hash(content.bytes) !== entry.sha256 ||
              (process.platform !== "win32" &&
                Boolean(content.stat.mode & 0o111) !== entry.executable)
            )
              throw new AppError(
                ErrorCode.Conflict,
                "Recovered workspace does not match the reviewed manifest",
              );
          }
        }
        if ((await gitValue(destination, ["rev-parse", "HEAD"])) !== manifest.sourceHead)
          throw new AppError(ErrorCode.Conflict, "Recovered base changed");
        const project = await this.projects.add(destination),
          result = {
            projectId: project.id,
            workspaceId: project.id,
            branch: `recovery/${row.id}`,
            sourceHead: manifest.sourceHead,
            files: manifest.entries.length,
          };
        await this.db
          .prepare("UPDATE workspace_transfers SET status='verified',result_json=? WHERE id=?")
          .run(JSON.stringify(result), row.id);
        return await this.transfer(scope, row.id);
      });
    } catch (error) {
      await this.db
        .prepare("UPDATE workspace_transfers SET status='failed' WHERE id=? AND status='importing'")
        .run(row.id);
      throw error;
    } finally {
      this.active.delete(row.id);
    }
  }
}

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteId,
  RemoteScope,
  Sha256Digest,
  type RemoteCommand,
  type RemoteOperation,
} from "@agentdesk/shared";
import type { ApprovalService } from "../approvals";
import type { RemoteApprovalService } from "./approvals";
import type { RemoteGrantStore } from "./grants";
import type { RemoteOperationStore } from "./operations";
import { payloadDigest } from "./digest";
import { gitValue, repositoryGit } from "./repository-git";
import { RepositoryLockManager } from "./repository-locks";
const FilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      !isAbsolute(path) &&
      path
        .split("/")
        .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "Expected a literal repository-relative file path",
  );
export const RepositoryPreviewInput = z.discriminatedUnion("kind", [
  z.strictObject({
    clientRequestId: RemoteId,
    kind: z.literal("commit"),
    files: z.array(FilePath).min(1).max(200),
    message: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    clientRequestId: RemoteId,
    kind: z.literal("push"),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    ref: z.string().startsWith("refs/heads/").max(1024),
  }),
]);
export type RepositoryPreviewInput = z.infer<typeof RepositoryPreviewInput>;
export const RepositoryExecuteInput = z.strictObject({
  clientRequestId: RemoteId,
  previewId: RemoteId,
  approvalId: RemoteId,
  version: z.number().int().positive(),
  actionDigest: Sha256Digest,
});
export type RepositoryExecuteInput = z.infer<typeof RepositoryExecuteInput>;
const State = z.object({
  head: z.string(),
  branch: z.string(),
  indexHash: z.string(),
  indexTree: z.string(),
  configHash: z.string(),
  filesHash: z.string(),
});
const Preview = z.object({
  previewId: RemoteId,
  ...RemoteScope.shape,
  kind: z.enum(["commit", "push"]),
  approvalId: RemoteId,
  version: z.literal(1),
  actionDigest: Sha256Digest,
  expiresAt: z.iso.datetime(),
  state: State,
  files: z.array(z.string()),
  message: z.string(),
  tree: z.string(),
  diff: z.string(),
  remote: z.string(),
  remoteUrl: z.string(),
  ref: z.string(),
  remoteHead: z.string().nullable(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
});
export type RepositoryPreview = z.infer<typeof Preview>;
export interface RepositoryOperationResult {
  operation: RemoteOperation;
  replayed: boolean;
}
export interface RepositoryStatus {
  head: string;
  branch: string;
  files: Array<{
    path: string;
    previousPath: string | null;
    indexStatus: string;
    worktreeStatus: string;
    kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  }>;
}
interface Dependencies {
  grants: RemoteGrantStore;
  operations: RemoteOperationStore;
  approvals: ApprovalService;
  remoteApprovals: RemoteApprovalService;
  resolveWorkspace: (scope: RemoteScope) => string | Promise<string>;
  locks?: RepositoryLockManager;
  allowedRemoteHosts?: readonly string[];
  gitConfig?: (url: string) => Record<string, string>;
  /** Only for host-controlled, local bare repository integration tests. Never exposed in HTTP input. */
  allowLocalRemotes?: boolean;
}
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scopeOf = (command: RemoteCommand): RemoteScope => ({
  userId: command.userId,
  hostId: command.hostId,
  projectId: command.projectId,
  workspaceId: command.workspaceId,
});
const json = (value: unknown) => z.json().parse(value);
const stale = () =>
  new AppError(
    ErrorCode.StalePreview,
    "Repository state changed; create and approve a new preview",
  );
export class RepositoryOperationService {
  readonly locks: RepositoryLockManager;
  constructor(private readonly deps: Dependencies) {
    this.locks = deps.locks ?? new RepositoryLockManager();
  }
  async status(command: RemoteCommand, raw: unknown): Promise<RepositoryStatus> {
    const input = z
      .strictObject({ kind: z.literal("git-status").optional(), clientRequestId: RemoteId })
      .parse(raw);
    const scope = await this.authorize(command, input, "project.read");
    const workspace = await this.deps.resolveWorkspace(scope);
    const state = await this.state(workspace, []);
    const output = (
      await repositoryGit(workspace, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--renames",
      ])
    ).stdout;
    const records = output.split("\0").filter(Boolean);
    const files: RepositoryStatus["files"] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const indexStatus = record.slice(0, 1);
      const worktreeStatus = record.slice(1, 2);
      const path = record.slice(3);
      const code = `${indexStatus}${worktreeStatus}`;
      const renamed = code.includes("R") || code.includes("C");
      const previousPath = renamed ? (records[++i] ?? null) : null;
      const kind =
        code.includes("U") || code === "AA" || code === "DD"
          ? "conflicted"
          : code === "??"
            ? "untracked"
            : renamed
              ? "renamed"
              : code.includes("D")
                ? "deleted"
                : code.includes("A")
                  ? "added"
                  : "modified";
      files.push({ path, previousPath, indexStatus, worktreeStatus, kind });
    }
    return {
      head: state.head,
      branch: state.branch,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  private async authorize(
    command: RemoteCommand,
    input: {
      clientRequestId: string;
    },
    action: "project.read" | "git.preview" | "git.commit" | "git.push",
  ) {
    if (command.action !== action || command.requestId !== input.clientRequestId)
      throw new AppError(ErrorCode.Forbidden, "Git action or request identity does not match");
    await this.deps.grants.authorize(command, input);
    const authAge = Date.now() - Date.parse(command.actor.recentAuthAt);
    if (
      (action === "git.commit" || action === "git.push") &&
      (authAge < -5000 || authAge > 15 * 60000)
    )
      throw new AppError(
        ErrorCode.Unauthorized,
        "Recent authentication is required for Git writes",
      );
    return scopeOf(command);
  }
  async preview(command: RemoteCommand, raw: unknown): Promise<RepositoryOperationResult> {
    const input = RepositoryPreviewInput.parse(raw);
    const scope = await this.authorize(command, input, "git.preview");
    const accepted = await this.deps.operations.accept(
      scope,
      "git.preview",
      input.clientRequestId,
      input,
    );
    if (accepted.replayed) return accepted;
    try {
      const workspace = await this.deps.resolveWorkspace(scope);
      return await this.locks.withLock(workspace, accepted.operation.operationId, async () => {
        await this.authorize(command, input, "git.preview");
        const files = input.kind === "commit" ? [...new Set(input.files)].sort() : [];
        const state = await this.state(workspace, files);
        let tree = "",
          diff = "",
          remoteUrl = "",
          remoteHead: string | null = null;
        let commits: RepositoryPreview["commits"] = [];
        if (input.kind === "commit") {
          await this.ensureSelectedIndex(workspace, files);
          await this.withIndex(workspace, async (index) => {
            await repositoryGit(workspace, ["read-tree", state.head], { index });
            await repositoryGit(workspace, ["add", "--", ...files], { index });
            tree = await gitValue(workspace, ["write-tree"], index);
            if (tree === (await gitValue(workspace, ["rev-parse", `${state.head}^{tree}`])))
              throw new AppError(
                ErrorCode.BadRequest,
                "Selected files contain no changes to commit",
              );
            diff = (
              await repositoryGit(workspace, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                state.head,
                tree,
                "--",
              ])
            ).stdout;
          });
        } else {
          await repositoryGit(workspace, ["check-ref-format", input.ref]);
          remoteUrl = await this.remoteUrl(workspace, input.remote);
          remoteHead = await this.remoteHead(workspace, remoteUrl, input.ref);
          if (remoteHead) {
            const ancestor = await repositoryGit(
              workspace,
              ["merge-base", "--is-ancestor", remoteHead, state.head],
              { allowFailure: true },
            );
            if (ancestor.code !== 0)
              throw new AppError(
                ErrorCode.Conflict,
                "Remote branch is not an ancestor; fetch and reconcile locally",
              );
          }
          const log = await gitValue(workspace, [
            "log",
            "--format=%H%x00%s",
            "--max-count=501",
            remoteHead ? `${remoteHead}..${state.head}` : state.head,
          ]);
          commits = log
            ? log.split("\n").map((line) => {
                const [sha = "", subject = ""] = line.split("\0");
                return { sha, subject };
              })
            : [];
          if (commits.length > 500)
            throw new AppError(ErrorCode.BadRequest, "Push contains too many commits to review");
          if (!commits.length)
            throw new AppError(ErrorCode.BadRequest, "There are no commits to push");
        }
        if (payloadDigest(state) !== payloadDigest(await this.state(workspace, files)))
          throw stale();
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        const content = {
          previewId: accepted.operation.operationId,
          ...scope,
          kind: input.kind,
          version: 1 as const,
          expiresAt,
          state,
          files,
          message: input.kind === "commit" ? input.message : "",
          tree,
          diff,
          remote: input.kind === "push" ? input.remote : "",
          remoteUrl,
          ref: input.kind === "push" ? input.ref : state.branch,
          remoteHead,
          commits,
        };
        const actionDigest = payloadDigest(content);
        const { approval } = await this.deps.approvals.create({
          kind: "tool",
          risk: "dangerous",
          title: input.kind === "commit" ? "Commit selected files" : "Push reviewed commits",
          detail:
            input.kind === "commit"
              ? `${files.length} files on ${state.branch}`
              : `${input.remote}: ${input.ref}`,
          payload: { ...content, actionDigest },
        });
        await this.deps.remoteApprovals.attach({
          ...scope,
          approvalId: approval.id,
          operationId: accepted.operation.operationId,
          taskId: null,
          action: input.kind === "commit" ? "git.commit" : "git.push",
          actionDigest,
          version: 1,
          expiresAt,
          resolvedBy: null,
          decision: null,
        });
        return {
          operation: await this.deps.operations.transition(
            scope,
            accepted.operation.operationId,
            "succeeded",
            json({ ...content, actionDigest, approvalId: approval.id }),
          ),
          replayed: false,
        };
      });
    } catch (error) {
      await this.deps.operations.transition(scope, accepted.operation.operationId, "failed", {
        error: error instanceof AppError ? error.code : ErrorCode.Internal,
      });
      throw error;
    }
  }
  async commit(command: RemoteCommand, input: unknown) {
    return await this.execute(command, input, "commit");
  }
  async push(command: RemoteCommand, input: unknown) {
    return await this.execute(command, input, "push");
  }
  private async approvedPreview(
    scope: RemoteScope,
    input: RepositoryExecuteInput,
    kind: "commit" | "push",
  ): Promise<RepositoryPreview> {
    const operation = await this.deps.operations.get(scope, input.previewId);
    if (!operation || operation.action !== "git.preview" || operation.status !== "succeeded")
      throw new AppError(ErrorCode.NotFound, "Git preview does not exist");
    const preview = Preview.parse(operation.result);
    const context = await this.deps.remoteApprovals.get(scope, input.approvalId);
    const approval = await this.deps.approvals.get(input.approvalId);
    if (Date.parse(preview.expiresAt) <= Date.now())
      throw new AppError(ErrorCode.ApprovalExpired, "Git preview has expired");
    if (
      !context ||
      context.operationId !== preview.previewId ||
      context.action !== `git.${kind}` ||
      context.version !== input.version ||
      context.actionDigest !== input.actionDigest ||
      context.decision !== true ||
      context.resolvedBy !== scope.userId ||
      approval?.status !== "approved" ||
      preview.kind !== kind ||
      preview.approvalId !== input.approvalId ||
      preview.actionDigest !== input.actionDigest
    )
      throw new AppError(ErrorCode.Forbidden, "This Git action has not been approved");
    return preview;
  }
  private async execute(
    command: RemoteCommand,
    raw: unknown,
    kind: "commit" | "push",
  ): Promise<RepositoryOperationResult> {
    const input = RepositoryExecuteInput.parse(raw);
    const scope = await this.authorize(command, input, `git.${kind}`);
    const accepted = await this.deps.operations.accept(
      scope,
      `git.${kind}`,
      input.clientRequestId,
      input,
    );
    if (accepted.replayed) return accepted;
    let running = false;
    try {
      const preview = await this.approvedPreview(scope, input, kind);
      const workspace = await this.deps.resolveWorkspace(scope);
      return await this.locks.withLock(workspace, accepted.operation.operationId, async () => {
        if (
          payloadDigest(preview.state) !== payloadDigest(await this.state(workspace, preview.files))
        )
          throw stale();
        if (
          kind === "push" &&
          ((await this.remoteUrl(workspace, preview.remote)) !== preview.remoteUrl ||
            (await this.remoteHead(workspace, preview.remoteUrl, preview.ref)) !==
              preview.remoteHead)
        )
          throw stale();
        await this.authorize(command, input, `git.${kind}`);
        await this.approvedPreview(scope, input, kind);
        const before = {
          kind,
          previewId: preview.previewId,
          beforeHead: preview.state.head,
          expectedTree: preview.tree,
          expectedMessage: preview.message,
          branch: preview.state.branch,
          remote: preview.remote,
          remoteUrl: preview.remoteUrl,
          ref: preview.ref,
          remoteHead: preview.remoteHead,
          indexHash: preview.state.indexHash,
        };
        await this.deps.operations.transition(
          scope,
          accepted.operation.operationId,
          "running",
          before,
        );
        running = true;
        let result: RemoteOperation["result"];
        if (kind === "commit")
          result = await this.commitTree(
            workspace,
            preview,
            async () => await this.authorize(command, input, "git.commit"),
          );
        else {
          if (
            payloadDigest(preview.state) !== payloadDigest(await this.state(workspace, [])) ||
            (await this.remoteHead(workspace, preview.remoteUrl, preview.ref)) !==
              preview.remoteHead
          )
            throw stale();
          await this.authorize(command, input, "git.push");
          await this.approvedPreview(scope, input, "push");
          const push = await repositoryGit(
            workspace,
            [
              "push",
              "--porcelain",
              "--no-follow-tags",
              "--recurse-submodules=no",
              "--",
              preview.remoteUrl,
              `${preview.state.head}:${preview.ref}`,
            ],
            {
              timeoutMs: 180000,
              allowFailure: true,
              config: this.deps.gitConfig?.(preview.remoteUrl),
            },
          );
          const actual = await this.remoteHead(workspace, preview.remoteUrl, preview.ref);
          if (actual !== preview.state.head) {
            if (actual === preview.remoteHead && push.code !== 0)
              return {
                operation: await this.deps.operations.transition(
                  scope,
                  accepted.operation.operationId,
                  "failed",
                  { ...before, error: "PUSH_FAILED", commitSha: preview.state.head },
                ),
                replayed: false,
              };
            throw new AppError(ErrorCode.Conflict, "Push result requires reconciliation");
          }
          result = {
            kind,
            commitSha: preview.state.head,
            remote: preview.remote,
            ref: preview.ref,
            remoteHead: actual,
          };
        }
        return {
          operation: await this.deps.operations.transition(
            scope,
            accepted.operation.operationId,
            "succeeded",
            result,
          ),
          replayed: false,
        };
      });
    } catch (error) {
      const current = (await this.deps.operations.get(scope, accepted.operation.operationId))!;
      const operation = await this.deps.operations.transition(
        scope,
        current.operationId,
        running ? "needs_reconciliation" : "failed",
        running
          ? current.result
          : { error: error instanceof AppError ? error.code : ErrorCode.Internal },
      );
      if (running) return { operation, replayed: false };
      throw error;
    }
  }
  private async commitTree(
    workspace: string,
    preview: RepositoryPreview,
    authorize: () => unknown,
  ): Promise<RemoteOperation["result"]> {
    if (payloadDigest(preview.state) !== payloadDigest(await this.state(workspace, preview.files)))
      throw stale();
    return this.withIndex(workspace, async (index) => {
      await repositoryGit(workspace, ["read-tree", preview.state.head], { index });
      await repositoryGit(workspace, ["add", "--", ...preview.files], { index });
      if ((await gitValue(workspace, ["write-tree"], index)) !== preview.tree) throw stale();
      authorize();
      const indexPath = await gitValue(workspace, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ]);
      const lockPath = `${indexPath}.lock`;
      let lock;
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new AppError(ErrorCode.RepoBusy, "The repository index is in use");
        throw error;
      }
      let installed = false;
      try {
        if (
          bytesHash(await readFile(indexPath)) !== preview.state.indexHash ||
          (await gitValue(workspace, ["rev-parse", "HEAD"])) !== preview.state.head
        )
          throw stale();
        const result = await repositoryGit(workspace, ["commit", "-m", preview.message], {
          index,
          timeoutMs: 180000,
          allowFailure: true,
        });
        const sha = await gitValue(workspace, ["rev-parse", "HEAD"]);
        if (result.code !== 0 && sha === preview.state.head)
          throw new AppError(
            ErrorCode.Conflict,
            "Commit hook or signing failed; original index was preserved",
          );
        const tree = await gitValue(workspace, ["rev-parse", `${sha}^{tree}`]);
        const parents = await gitValue(workspace, ["show", "-s", "--format=%P", sha]);
        if (
          tree !== preview.tree ||
          parents !== preview.state.head ||
          (await gitValue(workspace, ["symbolic-ref", "--short", "HEAD"])) !==
            preview.state.branch ||
          bytesHash(await readFile(indexPath)) !== preview.state.indexHash
        )
          throw new AppError(
            ErrorCode.StalePreview,
            "Actual commit differs from the approved tree; inspect it before pushing",
          );
        // The reviewed index must follow the new HEAD; retaining the old tree would stage a reversal.
        await repositoryGit(workspace, ["read-tree", tree], { index });
        await lock.writeFile(await readFile(index));
        await lock.sync();
        await lock.close();
        await rename(lockPath, indexPath);
        installed = true;
        return {
          kind: "commit",
          commitSha: sha,
          tree,
          branch: preview.state.branch,
          files: preview.files,
        };
      } finally {
        await lock.close();
        if (!installed) await rm(lockPath, { force: true });
      }
    });
  }
  /** Never re-executes an uncertain external operation. Only exact ref/tree evidence can complete it. */
  async reconcile(scope: RemoteScope, operationId: string): Promise<RemoteOperation> {
    const operation = await this.deps.operations.get(scope, operationId);
    if (!operation) throw new AppError(ErrorCode.NotFound, "Git operation does not exist");
    if (operation.status !== "needs_reconciliation") return operation;
    const record = z
      .object({
        kind: z.enum(["commit", "push"]),
        beforeHead: z.string(),
        expectedTree: z.string(),
        expectedMessage: z.string().optional(),
        branch: z.string(),
        remoteUrl: z.string(),
        ref: z.string(),
        remoteHead: z.string().nullable(),
        indexHash: z.string(),
      })
      .parse(operation.result);
    const workspace = await this.deps.resolveWorkspace(scope);
    if (record.kind === "push") {
      if ((await this.remoteHead(workspace, record.remoteUrl, record.ref)) === record.beforeHead)
        return await this.deps.operations.transition(scope, operationId, "succeeded", {
          kind: "push",
          commitSha: record.beforeHead,
          ref: record.ref,
          reconciled: true,
        });
      return operation;
    }
    const sha = await gitValue(workspace, ["rev-parse", record.branch]);
    if (sha === record.beforeHead)
      return await this.deps.operations.transition(scope, operationId, "failed", {
        ...record,
        error: "NO_COMMIT_CREATED",
        reconciled: true,
      });
    const tree = await gitValue(workspace, ["rev-parse", `${sha}^{tree}`]);
    const parents = await gitValue(workspace, ["show", "-s", "--format=%P", sha]);
    const message = await gitValue(workspace, ["show", "-s", "--format=%B", sha]);
    if (
      record.expectedMessage !== undefined &&
      tree === record.expectedTree &&
      parents === record.beforeHead &&
      message === record.expectedMessage.trim()
    )
      return await this.deps.operations.transition(scope, operationId, "succeeded", {
        kind: "commit",
        commitSha: sha,
        tree,
        branch: record.branch,
        reconciled: true,
        indexNeedsReview: true,
      });
    return operation;
  }
  private async withIndex<T>(workspace: string, action: (index: string) => Promise<T>): Promise<T> {
    const gitDir = await gitValue(workspace, ["rev-parse", "--absolute-git-dir"]);
    const dir = await mkdtemp(join(gitDir, "agentdesk-index-"));
    try {
      return await action(join(dir, "index"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async state(workspace: string, files: string[]): Promise<z.infer<typeof State>> {
    const root = await realpath(workspace);
    if ((await realpath(await gitValue(root, ["rev-parse", "--show-toplevel"]))) !== root)
      throw new AppError(ErrorCode.Forbidden, "Workspace must be the repository root");
    const branchResult = await repositoryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"], {
      allowFailure: true,
    });
    if (branchResult.code !== 0)
      throw new AppError(ErrorCode.Conflict, "Detached HEAD requires local reconciliation");
    for (const name of [
      "index.lock",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      const path = await gitValue(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
      ]);
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new AppError(
        ErrorCode.RepoBusy,
        "Git has an active lock, merge, rebase or sequencer operation",
      );
    }
    const head = await gitValue(root, ["rev-parse", "HEAD"]);
    const indexPath = await gitValue(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    const indexHash = bytesHash(await readFile(indexPath));
    const indexTree = await this.withIndex(root, async (index) => {
      await copyFile(indexPath, index);
      return gitValue(root, ["write-tree"], index);
    });
    const configHash = bytesHash(
      Buffer.from(
        (await repositoryGit(root, ["config", "--null", "--list", "--show-origin"])).stdout,
      ),
    );
    const hashes: Array<{
      path: string;
      hash: string;
      mode: number;
    }> = [];
    for (const path of files) {
      const full = resolve(root, path);
      const rel = relative(root, full);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new AppError(ErrorCode.Forbidden, "File escapes workspace");
      let parent = dirname(full);
      while (parent !== root) {
        try {
          const stat = await lstat(parent);
          if (stat.isSymbolicLink())
            throw new AppError(
              ErrorCode.Forbidden,
              "Symlink directories cannot be committed remotely",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        parent = dirname(parent);
      }
      try {
        const stat = await lstat(full);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
          throw new AppError(
            ErrorCode.BadRequest,
            "Only regular files up to 16 MiB can be reviewed remotely",
          );
        hashes.push({ path, hash: bytesHash(await readFile(full)), mode: stat.mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hashes.push({ path, hash: "deleted", mode: 0 });
      }
    }
    return {
      head,
      branch: branchResult.stdout.trim(),
      indexHash,
      indexTree,
      configHash,
      filesHash: payloadDigest(hashes),
    };
  }
  private async ensureSelectedIndex(workspace: string, files: string[]): Promise<void> {
    const staged = (
      await repositoryGit(workspace, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean);
    if (staged.some((path) => !files.includes(path)))
      throw new AppError(
        ErrorCode.Conflict,
        "Unselected files are already staged; explicitly include them or inspect the index locally",
      );
  }
  private async remoteUrl(workspace: string, remote: string): Promise<string> {
    const urls = (
      await gitValue(workspace, ["remote", "get-url", "--push", "--all", remote])
    ).split(/\r?\n/);
    if (urls.length !== 1 || !urls[0])
      throw new AppError(ErrorCode.BadRequest, "Remote must have one push URL");
    const value = urls[0];
    if (this.deps.allowLocalRemotes && isAbsolute(value)) return value;
    const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+)$/.exec(value);
    let hostname: string;
    if (scp) hostname = scp[1]!;
    else {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        if (this.deps.allowLocalRemotes && isAbsolute(value)) return value;
        throw new AppError(ErrorCode.Forbidden, "Remote protocol is not allowed");
      }
      if (this.deps.allowLocalRemotes && url.protocol === "file:") return value;
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        url.password ||
        (url.username && !(url.protocol === "ssh:" && url.username === "git")) ||
        url.search ||
        url.hash ||
        (url.port && !["443", "22"].includes(url.port))
      )
        throw new AppError(
          ErrorCode.Forbidden,
          "Remote URL must use an approved host without embedded credentials",
        );
      hostname = url.hostname;
    }
    if (
      !(this.deps.allowedRemoteHosts ?? ["github.com", "gitee.com"]).includes(
        hostname.toLowerCase(),
      )
    )
      throw new AppError(ErrorCode.Forbidden, "Remote host is not approved");
    return value;
  }
  private async remoteHead(workspace: string, url: string, ref: string): Promise<string | null> {
    const output = (
      await repositoryGit(workspace, ["ls-remote", "--refs", "--", url, ref], {
        config: this.deps.gitConfig?.(url),
      })
    ).stdout.trim();
    const matches = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter((entry) => entry[1] === ref);
    if (matches.length > 1) throw new AppError(ErrorCode.Conflict, "Remote ref is ambiguous");
    return matches[0]?.[0] ?? null;
  }
}

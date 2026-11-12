import { businessDatabase, type BusinessDatabase } from "../../db/business-database";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, realpath, rename, statfs } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AppError, ErrorCode, RemoteId } from "@agentdesk/shared";
import type { SecretStore } from "../../secrets";
import type { ProjectService } from "../projects";
import { repositoryGit } from "./repository-git";
import { payloadDigest } from "./digest";
const line = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\0]/.test(value));
export const RepositoryImportInput = z.strictObject({
  clientRequestId: RemoteId,
  url: z.string().max(2048),
  name: line,
  email: z.email().max(200),
});
export const GitCredentialInput = z.strictObject({
  url: z.string().max(2048),
  username: line.refine((value) => !value.includes(":")),
  token: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\r\n\0]/.test(value)),
});
interface ImportRow {
  id: string;
  request_id: string;
  payload_hash: string;
  input_json: string;
  status: string;
  project_id: string | null;
  created_at: string;
}
export function approvedRepositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(ErrorCode.BadRequest, "请输入 GitHub 或 Gitee HTTPS 仓库地址");
  }
  if (
    url.protocol !== "https:" ||
    !["github.com", "gitee.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(url.pathname)
  )
    throw new AppError(ErrorCode.Forbidden, "仅允许无凭据的 GitHub 或 Gitee HTTPS 仓库地址");
  return `${url.origin}${url.pathname.replace(/\.git$/, "")}.git`;
}
/** 云端初始化采用持久导入记录；断线重试只查询同一记录，不重复 clone。 */
export class CloudRepositorySetup {
  private readonly db: BusinessDatabase;
  readonly ready: Promise<void>;
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly abort = new AbortController();
  stop() {
    this.stopping = true;
    this.abort.abort();
  }
  constructor(
    db: Database.Database | BusinessDatabase,
    private readonly secrets: SecretStore,
    private readonly projects: ProjectService,
    private readonly dataDir: string,
    private readonly workspaceRoot: string,
  ) {
    this.db = businessDatabase(db);
    this.ready = Promise.resolve().then(async () => {
      await this.db
        .prepare("UPDATE cloud_repository_imports SET status='interrupted' WHERE status='running'")
        .run();
    });
  }
  private key(url: string) {
    return `cloud-git:${createHash("sha256").update(url).digest("hex")}`;
  }
  credentials(raw: unknown) {
    const input = GitCredentialInput.parse(raw),
      url = approvedRepositoryUrl(input.url);
    this.secrets.set(
      this.key(url),
      JSON.stringify({ username: input.username, token: input.token }),
    );
    return { url, hasToken: true };
  }
  credentialStatus(value: string) {
    const url = approvedRepositoryUrl(value);
    return { url, hasToken: this.secrets.has(this.key(url)) };
  }
  gitConfig(value: string): Record<string, string> {
    let url: string;
    try {
      url = approvedRepositoryUrl(value);
    } catch {
      return {};
    }
    const stored = this.secrets.get(this.key(url));
    if (!stored) return {};
    const { username, token } = JSON.parse(stored) as {
      username: string;
      token: string;
    };
    return {
      "credential.helper": "",
      [`http.${url}.extraHeader`]: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
      "http.sslVerify": "true",
    };
  }
  async test(value: string) {
    const url = approvedRepositoryUrl(value);
    await repositoryGit(this.workspaceRoot, ["ls-remote", "--exit-code", "--", url, "HEAD"], {
      config: this.gitConfig(url),
      timeoutMs: 25000,
    });
    return { readable: true, pushVerified: false };
  }
  /** 只下载明确分支的对象，不切换当前分支或更新工作区。调用方持有仓库锁。 */
  async fetchBase(workspace: string, ref: string) {
    z.string().startsWith("refs/heads/").max(1024).parse(ref);
    await repositoryGit(workspace, ["check-ref-format", ref]);
    const url = approvedRepositoryUrl(
      (await repositoryGit(workspace, ["remote", "get-url", "origin"])).stdout.trim(),
    );
    await repositoryGit(
      workspace,
      [
        "-c",
        "core.hooksPath=",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--refmap=",
        "--",
        url,
        ref,
      ],
      { timeoutMs: 25000, config: this.gitConfig(url) },
    );
    const head = (await repositoryGit(workspace, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    return { fetched: true, head };
  }
  async list() {
    return (
      (await this.db
        .prepare("SELECT * FROM cloud_repository_imports ORDER BY created_at DESC LIMIT 30")
        .all()) as ImportRow[]
    ).map((row) => this.public(row));
  }
  async get(id: string) {
    const row = (await this.db
      .prepare("SELECT * FROM cloud_repository_imports WHERE id=?")
      .get(RemoteId.parse(id))) as ImportRow | undefined;
    if (!row) throw new AppError(ErrorCode.NotFound, "仓库导入记录不存在");
    return this.public(row);
  }
  private public(row: ImportRow) {
    return {
      id: row.id,
      status: row.status,
      projectId: row.project_id,
      repository: (
        JSON.parse(row.input_json) as {
          url: string;
        }
      ).url,
      createdAt: row.created_at,
    };
  }
  async begin(raw: unknown) {
    const input = RepositoryImportInput.parse(raw);
    input.url = approvedRepositoryUrl(input.url);
    const hash = payloadDigest(input);
    const old = (await this.db
      .prepare("SELECT * FROM cloud_repository_imports WHERE request_id=?")
      .get(input.clientRequestId)) as ImportRow | undefined;
    if (old) {
      if (old.payload_hash !== hash)
        throw new AppError(ErrorCode.Conflict, "请求编号已被其他导入使用");
      return this.public(old);
    }
    if (this.stopping || this.active.size)
      throw new AppError(ErrorCode.Conflict, "已有仓库正在导入，请等待完成");
    const id = randomUUID();
    await this.db
      .prepare("INSERT INTO cloud_repository_imports VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        input.clientRequestId,
        hash,
        JSON.stringify(input),
        "running",
        null,
        new Date().toISOString(),
        null,
      );
    const operation = this.clone(id, input)
      .catch(async () => {
        await this.db
          .prepare("UPDATE cloud_repository_imports SET status='failed' WHERE id=?")
          .run(id);
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, operation);
    return await this.get(id);
  }
  private async clone(id: string, input: z.infer<typeof RepositoryImportInput>) {
    const root = await realpath(this.workspaceRoot),
      disk = await statfs(root);
    if (disk.bavail * disk.bsize < 512 * 1024 * 1024)
      throw new AppError(ErrorCode.Conflict, "仓库目录可用空间不足");
    const staging = join(root, ".agentdesk-imports", id);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const checkout = join(staging, "repository");
    await repositoryGit(
      staging,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-recurse-submodules",
        "--",
        input.url,
        checkout,
      ],
      { config: this.gitConfig(input.url), timeoutMs: 180000, signal: this.abort.signal },
    );
    await repositoryGit(checkout, ["config", "--local", "user.name", input.name]);
    await repositoryGit(checkout, ["config", "--local", "user.email", input.email]);
    const target = join(root, `cloud-${id}`);
    await rename(checkout, target);
    const project = await this.projects.add(target);
    await this.db
      .prepare("UPDATE cloud_repository_imports SET status='succeeded',project_id=? WHERE id=?")
      .run(project.id, id);
  }
  async dispose() {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
  }
}

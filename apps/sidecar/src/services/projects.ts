import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeText, type ModelResolver } from "@agentdesk/agent-core";
import {
  createAdapter,
  findRepositories,
  gitChangeSummary,
  gitClone,
  gitLog,
  gitPull,
  gitStatus,
  inspectRepository,
  isDirectory,
  launchProject,
  listClaudeSessions,
  normalizeCommitMessage,
  remoteIdentity,
} from "@agentdesk/integrations";
import {
  AiCommitInput,
  AppError,
  ErrorCode,
  type AiCommitJob,
  type AiCommitPreview,
  type ClaudeSession,
  type CommitInfo,
  type GitAccount,
  type LaunchTarget,
  type Project,
  type RemoteActivity,
  type RemoteRepo,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import type { SecretStore } from "../secrets";
import { errorMessage, newId, nowIso, shortHash } from "../util";
import type { SettingsService } from "./settings";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/ai-commit-worker.mjs");

type GitAccountDoc = Omit<GitAccount, "hasToken"> & { id: string };

const tokenId = (platform: string, host: string) => `git:${platform}:${host.toLowerCase()}`;

const DEFAULT_HOSTS: Record<string, string> = { github: "github.com", gitee: "gitee.com" };

export class ProjectService {
  private readonly projects: Collection<Project>;
  private readonly accounts: Collection<GitAccountDoc>;

  constructor(
    db: Db,
    private readonly secrets: SecretStore,
    private readonly settings: SettingsService,
    private readonly models: ModelResolver,
    private readonly dataDir: string,
  ) {
    this.projects = new Collection<Project>(db, "projects");
    this.accounts = new Collection<GitAccountDoc>(db, "gitAccounts");
  }

  list(): Project[] {
    return this.projects
      .list()
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.lastCommit?.date ?? "").localeCompare(a.lastCommit?.date ?? ""),
      );
  }

  get(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw new AppError(ErrorCode.NotFound, "项目不存在");
    return p;
  }

  /** 按 ID、名称或路径查找，方便 Agent 和工作流用自然的标识引用项目 */
  find(ref: string): Project {
    const byId = this.projects.get(ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    const match =
      this.list().find((p) => p.path.toLowerCase() === resolve(ref).toLowerCase()) ??
      this.list().find((p) => p.name.toLowerCase() === lower) ??
      this.list().find((p) => p.name.toLowerCase().includes(lower));
    if (!match) throw new AppError(ErrorCode.NotFound, `找不到项目：${ref}`);
    return match;
  }

  private gitlabHosts(): string[] {
    return this.accounts
      .list()
      .filter((a) => a.platform === "gitlab")
      .map((a) => a.host);
  }

  private async upsertFromPath(path: string): Promise<Project> {
    const info = await inspectRepository(path, this.gitlabHosts());
    const id = shortHash(path);
    const existing = this.projects.get(id);
    return this.projects.put({
      id,
      ...info,
      pinned: existing?.pinned ?? false,
      tags: existing?.tags ?? [],
      scannedAt: nowIso(),
    });
  }

  async scan(): Promise<{ found: number; removed: number }> {
    const roots = this.settings.get().scanRoots.filter((r) => existsSync(r));
    if (roots.length === 0)
      throw new AppError(ErrorCode.BadRequest, "请先在 设置 > 通用 中配置项目扫描目录");
    const paths = await findRepositories(roots);
    const known = new Set<string>();
    for (const batch of chunk(paths, 8)) {
      const results = await Promise.all(batch.map((p) => this.upsertFromPath(p).catch(() => null)));
      for (const r of results) if (r) known.add(r.id);
    }
    let removed = 0;
    for (const p of this.projects.list()) {
      if (!known.has(p.id) && !existsSync(p.path)) {
        this.projects.delete(p.id);
        removed++;
      }
    }
    return { found: paths.length, removed };
  }

  async add(path: string): Promise<Project> {
    const full = resolve(path);
    if (!(await isDirectory(full))) throw new AppError(ErrorCode.BadRequest, `目录不存在：${full}`);
    if (!existsSync(resolve(full, ".git")))
      throw new AppError(ErrorCode.BadRequest, "该目录不是 Git 仓库");
    return this.upsertFromPath(full);
  }

  /** 列出平台上的远程仓库，并标注本地是否已有克隆 / 是否已导入 */
  async listRemoteRepos(platform: "github" | "gitee" | "gitlab"): Promise<RemoteRepo[]> {
    const { adapter, token } = this.requireAdapter(platform);
    if (!adapter.listRepos)
      throw new AppError(ErrorCode.BadRequest, `${platform} 暂不支持仓库列表导入`);
    if (!token)
      throw new AppError(ErrorCode.BadRequest, `请先在 设置 > Git 平台 中配置 ${platform} Token`);

    let listed;
    try {
      listed = await adapter.listRepos();
    } catch (error) {
      throw new AppError(
        ErrorCode.IntegrationFailed,
        `拉取 ${platform} 仓库列表失败：${errorMessage(error)}`,
      );
    }

    const hosts = this.gitlabHosts();
    const localByIdentity = await this.mapLocalRemoteIdentities(hosts);
    const imported = new Set(
      this.list()
        .map((p) => (p.remoteUrl ? remoteIdentity(p.remoteUrl, hosts) : null))
        .filter((x): x is string => Boolean(x)),
    );

    return listed.map((r) => {
      const identity =
        remoteIdentity(r.cloneUrl, hosts) ?? `${platform}:${r.fullName}`.toLowerCase();
      return {
        id: r.id,
        platform,
        name: r.name,
        fullName: r.fullName,
        description: r.description,
        cloneUrl: r.cloneUrl,
        htmlUrl: r.htmlUrl,
        private: r.private,
        updatedAt: r.updatedAt,
        localPath: localByIdentity.get(identity) ?? null,
        imported: imported.has(identity),
      };
    });
  }

  /**
   * 从远程仓库导入：优先关联扫描目录中的本地克隆；
   * 否则 clone 到第一个扫描目录下。
   */
  async importRemoteRepo(
    platform: "github" | "gitee" | "gitlab",
    cloneUrl: string,
    fullName?: string,
  ): Promise<Project> {
    const { token } = this.requireAdapter(platform);
    const hosts = this.gitlabHosts();
    const identity = remoteIdentity(cloneUrl, hosts);
    if (!identity) throw new AppError(ErrorCode.BadRequest, "无效的仓库地址");

    const localByIdentity = await this.mapLocalRemoteIdentities(hosts);
    const existingPath = localByIdentity.get(identity);
    if (existingPath) return this.add(existingPath);

    const already = this.list().find(
      (p) => p.remoteUrl && remoteIdentity(p.remoteUrl, hosts) === identity,
    );
    if (already) return this.refresh(already.id);

    const roots = this.settings.get().scanRoots.filter((r) => existsSync(r));
    if (roots.length === 0)
      throw new AppError(
        ErrorCode.BadRequest,
        "请先在 设置 > 通用 中添加扫描目录，导入时会 clone 到该目录",
      );

    const repoName =
      fullName
        ?.split("/")
        .pop()
        ?.replace(/\.git$/, "") ||
      cloneUrl
        .replace(/\.git$/, "")
        .split("/")
        .pop() ||
      "repo";
    const target = join(roots[0]!, repoName);
    if (existsSync(target)) {
      if (existsSync(resolve(target, ".git"))) return this.add(target);
      throw new AppError(ErrorCode.BadRequest, `目标目录已存在且不是 Git 仓库：${target}`);
    }

    const authUrl = token ? injectCloneToken(cloneUrl, token) : cloneUrl;
    try {
      await gitClone(authUrl, target);
    } catch (error) {
      throw new AppError(ErrorCode.IntegrationFailed, errorMessage(error));
    }
    return this.add(target);
  }

  private requireAdapter(platform: "github" | "gitee" | "gitlab"): {
    adapter: NonNullable<ReturnType<typeof createAdapter>>;
    host: string;
    token: string | undefined;
  } {
    const host = DEFAULT_HOSTS[platform] || "";
    const account =
      this.accounts.list().find((a) => a.platform === platform) ??
      (host ? { id: `${platform}:${host}`, platform, host } : null);
    if (!account?.host)
      throw new AppError(ErrorCode.BadRequest, `请先在 设置 > Git 平台 中添加 ${platform}`);
    const token = this.secrets.get(tokenId(account.platform, account.host)) ?? undefined;
    const adapter = createAdapter(account.platform, account.host, token);
    if (!adapter) throw new AppError(ErrorCode.BadRequest, `不支持的平台：${platform}`);
    return { adapter, host: account.host, token };
  }

  /** 扫描目录内所有仓库的 remote → 本地路径 */
  private async mapLocalRemoteIdentities(hosts: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const roots = this.settings.get().scanRoots.filter((r) => existsSync(r));
    if (!roots.length) {
      for (const p of this.list()) {
        if (!p.remoteUrl) continue;
        const id = remoteIdentity(p.remoteUrl, hosts);
        if (id) map.set(id, p.path);
      }
      return map;
    }
    const paths = await findRepositories(roots);
    for (const batch of chunk(paths, 12)) {
      await Promise.all(
        batch.map(async (path) => {
          try {
            const info = await inspectRepository(path, hosts);
            if (!info.remoteUrl) return;
            const id = remoteIdentity(info.remoteUrl, hosts);
            if (id && !map.has(id)) map.set(id, path);
          } catch {
            /* skip */
          }
        }),
      );
    }
    for (const p of this.list()) {
      if (!p.remoteUrl) continue;
      const id = remoteIdentity(p.remoteUrl, hosts);
      if (id && !map.has(id)) map.set(id, p.path);
    }
    return map;
  }

  async refresh(id: string): Promise<Project> {
    return this.upsertFromPath(this.get(id).path);
  }

  patch(id: string, patch: { pinned?: boolean; tags?: string[] }): Project {
    const updated = this.projects.update(id, (p) => ({ ...p, ...patch }));
    if (!updated) throw new AppError(ErrorCode.NotFound, "项目不存在");
    return updated;
  }

  remove(id: string): void {
    this.projects.delete(id);
  }

  async commits(id: string, limit = 15): Promise<CommitInfo[]> {
    return gitLog(this.get(id).path, limit);
  }

  async status(ref: string): Promise<{ project: Project; status: string; commits: CommitInfo[] }> {
    const project = await this.refresh(this.find(ref).id);
    const [status, commits] = await Promise.all([gitStatus(project.path), gitLog(project.path, 5)]);
    return { project, status, commits };
  }

  async pull(ref: string): Promise<string> {
    const project = this.find(ref);
    const output = await gitPull(project.path);
    await this.refresh(project.id);
    return output;
  }

  /** 检测暂存区/工作区变更，用 AI 生成 Conventional Commits 风格的提交说明。 */
  async prepareAiCommit(id: string): Promise<AiCommitPreview> {
    const project = this.get(id);
    const summary = await gitChangeSummary(project.path);
    if (!summary.hasStaged && !summary.hasUnstaged && summary.ahead === 0) {
      throw new AppError(ErrorCode.BadRequest, "没有可提交或推送的改动");
    }
    const willStageAll = !summary.hasStaged && summary.hasUnstaged;
    const diffForAi = summary.hasStaged
      ? summary.stagedDiff
      : summary.unstagedDiff || summary.status;
    let suggestedMessage = "chore: update";
    if (diffForAi.trim() || summary.status.trim()) {
      const models = await this.models.resolve("project");
      if (models.length === 0) {
        throw new AppError(ErrorCode.BadRequest, "请先在 设置 > 模型 Provider 中配置可用模型");
      }
      try {
        const raw = await completeText({
          models,
          systemPrompt: `你是资深工程师，根据 git diff 写一条 commit message。
硬性要求：
- 只输出一行纯文本，格式：type(scope): subject（Conventional Commits）
- type 仅限 feat/fix/docs/refactor/chore/test/perf/style
- 不超过 72 字符，不要句号结尾
- 禁止输出 JSON、Markdown 代码块、引号包裹或任何解释`,
          prompt: `仓库：${project.name}\n分支：${summary.branch ?? "?"}\n\ngit status:\n${summary.status}\n\ndiff:\n${diffForAi || "(无 diff，仅有状态)"}\n\n只回复一行 commit subject：`,
          maxTokens: 60,
          signal: AbortSignal.timeout(45_000),
        });
        suggestedMessage = normalizeCommitMessage(raw) || suggestedMessage;
      } catch (error) {
        throw new AppError(
          ErrorCode.ProviderUnavailable,
          `生成提交说明失败：${errorMessage(error)}`,
        );
      }
    } else if (summary.ahead > 0) {
      suggestedMessage = "";
    }
    return {
      projectId: project.id,
      branch: summary.branch,
      status: summary.status,
      stagedFiles: summary.stagedFiles,
      unstagedFiles: summary.unstagedFiles,
      hasStaged: summary.hasStaged,
      hasUnstaged: summary.hasUnstaged,
      ahead: summary.ahead,
      willStageAll,
      suggestedMessage,
      diffPreview: (summary.hasStaged ? summary.stagedDiff : summary.unstagedDiff).slice(0, 6_000),
    };
  }

  /**
   * 启动独立进程执行 commit/push，立即返回 jobId。
   * 前端轮询 getAiCommitJob，避免 husky 改文件把 tsx watch 的 sidecar 重启掉。
   */
  async startAiCommit(id: string, input: unknown): Promise<{ jobId: string }> {
    const data = AiCommitInput.parse(input);
    const project = this.get(id);
    const summary = await gitChangeSummary(project.path);
    const hasChanges = summary.hasStaged || summary.hasUnstaged;
    if (!hasChanges && summary.ahead === 0) {
      throw new AppError(ErrorCode.BadRequest, "没有可提交或推送的改动");
    }

    let message = normalizeCommitMessage(data.message);
    const needsCommit = hasChanges;
    if (needsCommit) {
      if (!message) throw new AppError(ErrorCode.BadRequest, "请填写提交说明");
      if (
        !/^(feat|fix|docs|refactor|chore|test|perf|style|build|ci|revert)(\(.+\))?!?: /.test(
          message,
        )
      ) {
        throw new AppError(
          ErrorCode.BadRequest,
          `提交说明需符合 Conventional Commits，例如 feat(projects): add ai commit。当前：${message}`,
        );
      }
      if (!summary.hasStaged && !data.stageAll) {
        throw new AppError(ErrorCode.BadRequest, "暂存区为空：请先 git add，或勾选暂存全部改动");
      }
    } else {
      message = message || project.lastCommit?.message || "(no new commit)";
    }

    if (!existsSync(WORKER)) {
      throw new AppError(ErrorCode.IntegrationFailed, `找不到提交 worker：${WORKER}`);
    }

    const jobId = newId();
    const jobsDir = join(this.dataDir, "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const jobPath = join(jobsDir, `${jobId}.json`);
    writeFileSync(
      jobPath,
      JSON.stringify({
        id: jobId,
        status: "running",
        projectId: project.id,
        repoPath: project.path,
        message,
        needsCommit,
        stageAll: needsCommit && (data.stageAll || !summary.hasStaged),
        push: data.push,
        commitHash: needsCommit ? "" : (project.lastCommit?.hash.slice(0, 7) ?? ""),
      }),
    );

    const child = spawn(process.execPath, [WORKER, jobPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { jobId };
  }

  async getAiCommitJob(id: string, jobId: string): Promise<AiCommitJob> {
    this.get(id);
    const jobPath = join(this.dataDir, "jobs", `${jobId}.json`);
    if (!existsSync(jobPath)) throw new AppError(ErrorCode.NotFound, "提交任务不存在");
    const raw = JSON.parse(readFileSync(jobPath, "utf8")) as {
      id: string;
      status: "running" | "done" | "error";
      error?: string;
      result?: {
        projectId: string;
        message: string;
        commitHash: string;
        pushed: boolean;
        pushOutput: string;
      };
    };
    if (raw.status === "done" && raw.result) {
      const project = await this.refresh(id);
      return {
        id: raw.id,
        status: "done",
        result: { ...raw.result, project },
      };
    }
    if (raw.status === "error") {
      return { id: raw.id, status: "error", error: raw.error ?? "提交失败" };
    }
    return { id: raw.id, status: "running" };
  }

  async activity(id: string): Promise<RemoteActivity[]> {
    const p = this.get(id);
    if (!p.owner || !p.repo || !p.host) return [];
    const host = p.host.split(":")[0]!;
    const adapter = createAdapter(
      p.platform,
      p.host,
      this.secrets.get(tokenId(p.platform, host)) ?? undefined,
    );
    if (!adapter) return [];
    try {
      return await adapter.listActivity(p.owner, p.repo);
    } catch (error) {
      throw new AppError(
        ErrorCode.IntegrationFailed,
        `拉取 ${p.platform} 数据失败：${errorMessage(error)}`,
      );
    }
  }

  launch(ref: string, target: LaunchTarget): Project {
    const project = this.find(ref);
    const settings = this.settings.get();
    launchProject(target, project.path, {
      cursorCommand: settings.cursorCommand,
      claudeCommand: settings.claudeCommand,
    });
    return project;
  }

  async claudeSessions(projectId?: string): Promise<ClaudeSession[]> {
    return listClaudeSessions(projectId ? this.get(projectId).path : undefined);
  }

  // ---------- Git 平台账号 ----------

  listAccounts(): GitAccount[] {
    return this.accounts.list().map(({ id: _id, ...a }) => ({
      ...a,
      hasToken: this.secrets.has(tokenId(a.platform, a.host)),
    }));
  }

  saveAccount(input: {
    platform: GitAccount["platform"];
    host?: string;
    token?: string;
  }): GitAccount {
    const host = (input.host?.trim() || DEFAULT_HOSTS[input.platform] || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    if (!host) throw new AppError(ErrorCode.BadRequest, "GitLab 需要填写主机地址");
    const id = `${input.platform}:${host.toLowerCase()}`;
    this.accounts.put({ id, platform: input.platform, host });
    if (input.token) this.secrets.set(tokenId(input.platform, host), input.token);
    return {
      platform: input.platform,
      host,
      hasToken: this.secrets.has(tokenId(input.platform, host)),
    };
  }

  deleteAccount(id: string): void {
    const account = this.accounts.get(id);
    if (!account) return;
    this.secrets.delete(tokenId(account.platform, account.host));
    this.accounts.delete(id);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 把 Token 写入 clone URL，便于私有仓库拉取（不落盘到 git remote） */
function injectCloneToken(cloneUrl: string, token: string): string {
  try {
    const u = new URL(cloneUrl);
    if (!u.username) {
      u.username = "oauth2";
      u.password = token;
    }
    return u.toString();
  } catch {
    return cloneUrl;
  }
}

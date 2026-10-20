import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAdapter,
  findRepositories,
  gitLog,
  gitPull,
  gitStatus,
  inspectRepository,
  isDirectory,
  launchProject,
  listClaudeSessions,
} from "@agentdesk/integrations";
import {
  AppError,
  ErrorCode,
  type ClaudeSession,
  type CommitInfo,
  type GitAccount,
  type LaunchTarget,
  type Project,
  type RemoteActivity,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import type { SecretStore } from "../secrets";
import { errorMessage, nowIso, shortHash } from "../util";
import type { SettingsService } from "./settings";

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

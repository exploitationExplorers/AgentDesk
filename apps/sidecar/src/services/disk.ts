import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statfsSync, type Stats } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import {
  AppError,
  DiskTier,
  ErrorCode,
  type DiskCandidate,
  type DiskCategory,
  type DiskCleanCommitRequest,
  type DiskCleanPlan,
  type DiskCleanRequest,
  type DiskCleanResult,
  type DiskDirectoryUsage,
  type DiskMode,
  type DiskScan,
  type DiskStatus,
  type DiskTier as DiskTierValue,
  type DiskVolume,
  type DiskUsageEntry,
} from "@agentdesk/shared";
import { newId } from "../util";
import type { SettingsService } from "./settings";
import {
  applyTierGuard,
  cacheRules,
  DEFAULT_DISK_LIMITS,
  detectDiskEnv,
  formatBytes,
  genericCacheRoots,
  isProtectedPath,
  isProtectedVolumePath,
  isSafeDeletionTarget,
  isStrictChild,
  pathKey,
  protectedPrefixes,
  userContentRoots,
  type DiskEnv,
  type DiskLimits,
  type DiskRule,
} from "./disk-rules";
import { discoverVolumes, volumeForPath, type VolumeRoot } from "./disk-volumes";
import { inspectVolume } from "./disk-inventory";

const execFileAsync = promisify(execFile);
const SCAN_TTL_MS = 30 * 60_000;

interface InternalItem {
  id: string;
  title: string;
  path: string;
  realPath: string;
  bytes: number;
  tier: DiskTierValue;
  ruleTier: DiskTierValue;
  category: DiskCategory;
  reason: string;
  mode: DiskMode;
  regenerable: boolean;
  protected: boolean;
  locked: boolean;
  hasGit: boolean;
  daysSinceUsed: number | null;
  truncated: boolean;
  identity?: string;
  contentsIdentity?: string;
}

interface StoredScan {
  id: string;
  at: number;
  partial: boolean;
  items: InternalItem[];
  status: DiskStatus;
  usage: DiskUsageEntry[];
}

interface Measured {
  bytes: number;
  newestMs: number;
  truncated: boolean;
  hasGit: boolean;
  identity: string;
}

const ReviewSchema = z.object({
  summary: z.string().min(1).max(200),
  items: z
    .array(
      z.object({
        id: z.string(),
        tier: DiskTier,
        title: z.string().min(1).max(200),
        reason: z.string().min(1).max(200),
      }),
    )
    .max(80),
});

export interface DiskServiceOptions {
  env?: DiskEnv;
  limits?: DiskLimits;
  extraProtected?: string[];
  /** 测试里关闭，避免碰到本机回收站 */
  systemTrash?: boolean;
  /** 测试时注入临时目录，避免扫描真实磁盘。 */
  volumes?: VolumeRoot[];
}

/**
 * 磁盘扫描与确认后清理。规则只覆盖可重建缓存和常见大文件；
 * 删除必须命中本次扫描，并再次校验真实路径。
 */
export class DiskService {
  private readonly env: DiskEnv;
  private readonly limits: DiskLimits;
  private readonly extraProtected: string[];
  private readonly systemTrash: boolean;
  private readonly volumes?: VolumeRoot[];
  private latest: StoredScan | null = null;
  private cleaning = false;

  constructor(
    private readonly settings: SettingsService,
    private readonly providers: ModelResolver,
    options: DiskServiceOptions = {},
  ) {
    this.env = options.env ?? detectDiskEnv();
    this.limits = options.limits ?? DEFAULT_DISK_LIMITS;
    this.extraProtected = options.extraProtected ?? [];
    this.systemTrash = options.systemTrash ?? true;
    this.volumes = options.volumes;
  }

  async status(volumePath?: string): Promise<DiskStatus> {
    let roots: VolumeRoot[];
    try {
      roots = this.volumes ?? (await discoverVolumes(this.env));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取磁盘空间";
      throw new AppError(ErrorCode.IntegrationFailed, message);
    }
    const thresholdBytes = this.settings.get().diskThresholdGB * 1024 ** 3;
    const homeVolume = volumeForPath(this.env.home, roots, this.env);
    const volumes: DiskVolume[] = [];
    for (const root of roots) {
      if (
        volumes.some(
          (volume) =>
            pathKey(volume.volumePath, this.env.platform) === pathKey(root.path, this.env.platform),
        )
      )
        continue;
      try {
        const stats = statfsSync(root.path);
        const totalBytes = Math.max(0, Number(stats.blocks) * Number(stats.bsize));
        const freeBytes = Math.max(
          0,
          Math.min(totalBytes, Number(stats.bavail) * Number(stats.bsize)),
        );
        if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes))
          continue;
        volumes.push({
          volumePath: root.path,
          label: root.label || root.path,
          isHome: root === homeVolume,
          totalBytes,
          freeBytes,
          usedBytes: totalBytes - freeBytes,
          thresholdBytes,
          low: freeBytes < thresholdBytes,
        });
      } catch {
        // 移动盘可能在枚举后断开，忽略不可读卷。
      }
    }
    const selected = volumePath
      ? volumes.find(
          (volume) =>
            pathKey(volume.volumePath, this.env.platform) ===
            pathKey(volumePath, this.env.platform),
        )
      : [...volumes].sort(
          (a, b) =>
            Number(b.low) - Number(a.low) ||
            a.freeBytes / a.totalBytes - b.freeBytes / b.totalBytes ||
            Number(b.isHome) - Number(a.isHome),
        )[0];
    if (!selected) throw new AppError(ErrorCode.BadRequest, "磁盘不可用，请刷新后选择本机磁盘");
    const platform = this.env.platform;
    return {
      ...selected,
      platform:
        platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other",
      volumes,
    };
  }

  current(): DiskScan | null {
    const scan = this.freshScan();
    return scan ? this.toPublic(scan) : null;
  }

  async inspectDirectory(volumePath: string, directory: string): Promise<DiskDirectoryUsage> {
    const status = await this.status(volumePath);
    const volume = { path: status.volumePath, label: status.label };
    const roots = status.volumes.map((entry) => ({ path: entry.volumePath, label: entry.label }));
    const owner = volumeForPath(directory, roots, this.env);
    if (
      !isAbsolute(directory) ||
      !owner ||
      pathKey(owner.path, this.env.platform) !== pathKey(volume.path, this.env.platform)
    )
      throw new AppError(ErrorCode.BadRequest, "请选择当前磁盘内的目录");
    const target = resolve(directory);
    const userRoot = userContentRoots(this.env).find(
      ({ path }) =>
        pathKey(path, this.env.platform) === pathKey(target, this.env.platform) ||
        isStrictChild(path, target, this.env.platform),
    )?.path;
    const prefixes = this.prefixes();
    const boundary = userRoot ?? volume.path;
    let dependencyRoot: string | undefined;
    for (
      let ancestor = target;
      isStrictChild(boundary, ancestor, this.env.platform);
      ancestor = dirname(ancestor)
    ) {
      if (basename(ancestor).toLowerCase() === "node_modules") dependencyRoot = ancestor;
    }
    if (isProtectedVolumePath(target, boundary, this.env, prefixes, !!userRoot, dependencyRoot))
      throw new AppError(ErrorCode.BadRequest, "该目录不在可分析范围内");
    try {
      const [stat, actual] = await Promise.all([lstat(target), realpath(target)]);
      if (
        !stat.isDirectory() ||
        pathKey(actual, this.env.platform) !== pathKey(target, this.env.platform)
      )
        throw new Error("目录无效");
      if (dependencyRoot && !(await lstat(join(dirname(dependencyRoot), "package.json"))).isFile())
        throw new Error("缺少项目清单");
      const [{ usage, partial }, git] = await Promise.all([
        inspectVolume(
          volume,
          roots,
          this.env,
          prefixes,
          this.limits,
          { left: this.limits.maxEntriesPerItem },
          target,
          userRoot,
          dependencyRoot,
        ),
        inspectDiskRepository(target),
      ]);
      return {
        path: target,
        usage: usage.slice(0, 200),
        partial: partial || usage.length > 200,
        git,
      };
    } catch {
      throw new AppError(ErrorCode.BadRequest, "无法读取该目录，请检查路径和访问权限");
    }
  }

  async scan(volumePath?: string): Promise<DiskScan> {
    if (this.cleaning) throw new AppError(ErrorCode.Conflict, "清理完成后再扫描磁盘");
    const status = await this.status(volumePath);
    const roots = status.volumes.map((volume) => ({
      path: volume.volumePath,
      label: volume.label,
    }));
    const volume = { path: status.volumePath, label: status.label };
    const belongs = (target: string) => {
      const owner = volumeForPath(target, roots, this.env);
      return (
        owner && pathKey(owner.path, this.env.platform) === pathKey(volume.path, this.env.platform)
      );
    };
    const prefixes = this.prefixes();
    const items: InternalItem[] = [];
    const seen = new Set<string>();
    const budget = { left: this.limits.maxEntries };
    let partial = false;
    let seq = 0;
    const nextId = () => `d${String(++seq).padStart(3, "0")}`;

    const consider = async (
      target: string,
      spec: {
        title: string;
        category: DiskCategory;
        tier: DiskTierValue;
        mode: DiskMode;
        regenerable: boolean;
        reason: string;
        locked?: boolean;
        minBytes: number;
        hasGit?: boolean;
      },
    ) => {
      if (!belongs(target)) return;
      if (budget.left <= 0) {
        partial = true;
        return;
      }
      const added = await this.considerPath(target, spec, prefixes, budget, nextId, volume.path);
      if (!added) return;
      if (!belongs(added.realPath)) return;
      if (added.truncated) partial = true;
      const key = pathKey(added.realPath, this.env.platform);
      // 避免父目录与缓存子项重复计入可释放空间。
      if (
        seen.has(key) ||
        items.some(
          (item) =>
            item.tier !== "keep" &&
            added.tier !== "keep" &&
            (isStrictChild(item.realPath, added.realPath, this.env.platform) ||
              isStrictChild(added.realPath, item.realPath, this.env.platform)),
        )
      )
        return;
      seen.add(key);
      items.push(added);
    };

    for (const rule of cacheRules(this.env.platform)) {
      for (const target of rule.paths(this.env)) {
        await consider(target, this.specFromRule(rule));
      }
    }
    for (const target of await firefoxCaches(this.env)) {
      await consider(target, {
        title: "Firefox 网页缓存",
        category: "browser",
        tier: "primary",
        mode: "contents",
        regenerable: true,
        reason: "网页缓存，删除后自动重建；书签和登录状态不在这个目录",
        minBytes: this.limits.knownMinBytes,
      });
    }
    for (const target of await jetbrainsCaches(this.env)) {
      await consider(target, {
        title: "JetBrains 缓存",
        category: "app",
        tier: "primary",
        mode: "contents",
        regenerable: true,
        reason: "索引缓存，下次打开项目会重新建立索引",
        minBytes: this.limits.knownMinBytes,
      });
    }
    await this.collectGeneric(consider, prefixes);
    await this.collectUserFiles(consider);
    // 为候选的最终路径校验保留预算，目录统计和清理列表分别展示。
    const inventoryBudget = { left: Math.max(0, budget.left - 200) };
    const inventory = await inspectVolume(
      volume,
      roots,
      this.env,
      prefixes,
      this.limits,
      inventoryBudget,
    );
    partial ||= inventory.partial;
    budget.left = Math.min(budget.left, 200) + inventoryBudget.left;
    for (const file of inventory.files) {
      await consider(file.path, {
        title: basename(file.path),
        category: "user",
        tier: file.retain ? "keep" : "optional",
        mode: "whole",
        regenerable: false,
        locked: true,
        minBytes: this.limits.largeFileMinBytes,
        reason: file.retain
          ? "项目、程序或数据文件，仅展示占用，建议在对应应用中管理"
          : "所选磁盘中的大文件，确认不再需要后再清理",
      });
    }
    if (this.systemTrash) {
      const trash = await this.trashItem(nextId, status);
      if (trash) items.push(trash);
    }

    items.sort((a, b) => b.bytes - a.bytes);
    const stored: StoredScan = {
      id: newId(),
      at: Date.now(),
      partial,
      items,
      status,
      usage: inventory.usage,
    };
    if (this.cleaning) throw new AppError(ErrorCode.Conflict, "清理完成后再扫描磁盘");
    this.latest = stored;
    return this.toPublic(stored);
  }

  async review(scanId: string): Promise<DiskScan> {
    const scan = this.requireScan(scanId);
    const models = await this.providers.resolve("orchestrator");
    if (models.length === 0) {
      throw new AppError(ErrorCode.ProviderUnavailable, "没有可用的模型，仍使用规则判断");
    }
    const ranked = [...scan.items].sort((a, b) => b.bytes - a.bytes).slice(0, 40);
    const payload = ranked.map((item) => ({
      id: item.id,
      title: item.title,
      bytes: item.bytes,
      daysSinceUsed: item.daysSinceUsed,
      tier: item.tier,
      category: item.category,
      regenerable: item.regenerable,
      protected: item.protected,
      hasGit: item.hasGit,
      reason: item.reason,
    }));
    let parsed: z.infer<typeof ReviewSchema>;
    try {
      parsed = await completeStructured({
        models,
        schema: ReviewSchema,
        maxTokens: 2500,
        systemPrompt: `你是磁盘清理顾问。根据扫描结果给每一项写给普通用户看的名称和一句话说明，并确认档位。
档位只能是 primary（可自动重建的缓存）、optional（要用户决定）、keep（不清理）。
硬规则：protected 或 hasGit 必须是 keep；category 为 user 的最高只能是 optional；regenerable 为 false 的不能是 primary；不能把档位改得比当前 tier 更激进。
拿不准就保持原档位。title 不超过 16 个字，reason 不超过 40 个字。summary 不超过 60 个字，说明大约能释放多少、最大头是什么。
只输出 JSON。`,
        prompt: JSON.stringify({
          volume: scan.status,
          usage: scan.usage
            .slice(0, 20)
            .map(({ title, bytes, truncated }) => ({ title, bytes, truncated })),
          items: payload,
          partial: scan.partial,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型复核失败";
      throw new AppError(ErrorCode.ProviderUnavailable, message);
    }
    this.requireScan(scanId);
    if (this.cleaning) throw new AppError(ErrorCode.Conflict, "清理期间无法修改本次建议");
    const byId = new Map(parsed.items.map((item) => [item.id, item]));
    for (const item of scan.items) {
      const suggestion = byId.get(item.id);
      item.tier = applyTierGuard(item, suggestion?.tier);
      if (suggestion?.title) item.title = suggestion.title.trim().slice(0, 40);
      if (suggestion?.reason) item.reason = suggestion.reason.trim().slice(0, 80);
    }
    const published = this.toPublic(scan);
    const summary = parsed.summary.trim();
    if (summary) published.summary = summary.slice(0, 120);
    return published;
  }

  planClean(input: DiskCleanRequest): DiskCleanPlan {
    const scan = this.requireScan(input.scanId);
    const optionalAction = this.settings.get().diskOptionalAction;
    const items: DiskCleanPlan["items"] = [];
    const skipped: DiskCleanPlan["skipped"] = [];
    for (const id of [...new Set(input.ids)].sort()) {
      const item = scan.items.find((candidate) => candidate.id === id);
      if (!item || !toCandidate(item).selectable || item.hasGit) {
        skipped.push({
          id,
          path: item?.path ?? "",
          reason: item ? "这一项只展示，不会清理" : "不在本次扫描结果里",
        });
        continue;
      }
      items.push({
        id,
        path: item.path,
        title: item.title,
        bytes: item.bytes,
        mode: item.mode,
        action:
          item.mode !== "recycle" && item.tier === "optional" && optionalAction === "trash"
            ? "trash"
            : "delete",
      });
    }
    if (
      items.some((item) => item.mode === "recycle") &&
      items.some((item) => item.action === "trash")
    )
      throw new AppError(ErrorCode.BadRequest, "请分开确认移入回收站和清空回收站");
    const token = createHash("sha256")
      .update(JSON.stringify([scan.id, scan.status.volumePath, items, skipped]))
      .digest("hex");
    return { token, volumePath: scan.status.volumePath, items, skipped };
  }

  confirmClean(input: DiskCleanCommitRequest): DiskCleanPlan {
    const plan = this.planClean(input);
    if (plan.token !== input.planToken)
      throw new AppError(ErrorCode.Conflict, "清理清单已变化，请重新预览并确认");
    return plan;
  }

  async clean(input: DiskCleanCommitRequest): Promise<DiskCleanResult> {
    if (this.cleaning) throw new AppError(ErrorCode.Conflict, "正在处理另一份清理清单");
    this.cleaning = true;
    try {
      const scan = this.requireScan(input.scanId);
      const before = await this.status(scan.status.volumePath);
      const plan = this.confirmClean(input);
      const result: DiskCleanResult = {
        freedBytes: 0,
        freeBytesBefore: before.freeBytes,
        cleaned: [],
        skipped: plan.skipped,
      };
      for (const entry of plan.items) {
        const item = scan.items.find((candidate) => candidate.id === entry.id)!;
        const outcome = await this.cleanOne(
          item,
          entry.action,
          scan.status.volumePath,
          before.volumes,
        );
        if (!outcome.ok) {
          result.skipped.push({ id: item.id, path: item.path, reason: outcome.reason });
          continue;
        }
        result.cleaned.push({
          id: item.id,
          path: item.path,
          bytes: item.bytes,
          action: outcome.action,
        });
        if (outcome.action === "delete") result.freedBytes += item.bytes;
        item.bytes = 0;
        item.tier = "keep";
        item.ruleTier = "keep";
      }
      const after = await this.status(scan.status.volumePath).catch(() => undefined);
      if (after) result.freeBytesAfter = after.freeBytes;
      return result;
    } finally {
      this.cleaning = false;
    }
  }

  reveal(scanId: string, id: string): void {
    const scan = this.requireScan(scanId);
    const item = scan.items.find((candidate) => candidate.id === id);
    if (!item) throw new AppError(ErrorCode.NotFound, "扫描结果里没有这一项");
    if (item.mode === "recycle" && this.env.platform === "win32") {
      openDetached("explorer.exe", ["shell:RecycleBinFolder"]);
      return;
    }
    const target = item.mode === "recycle" ? join(this.env.home, ".Trash") : item.path;
    if (this.env.platform === "win32") {
      openDetached("explorer.exe", [`/select,${target}`]);
      return;
    }
    if (this.env.platform === "darwin") {
      openDetached("open", ["-R", target]);
      return;
    }
    openDetached("xdg-open", [target]);
  }

  private specFromRule(rule: DiskRule) {
    return {
      title: rule.title,
      category: rule.category,
      tier: rule.tier,
      mode: rule.mode,
      regenerable: rule.regenerable,
      reason: rule.reason,
      locked: rule.locked ?? rule.tier !== "primary",
      minBytes: rule.minBytes ?? this.limits.knownMinBytes,
    };
  }

  private async considerPath(
    target: string,
    spec: {
      title: string;
      category: DiskCategory;
      tier: DiskTierValue;
      mode: DiskMode;
      regenerable: boolean;
      reason: string;
      locked?: boolean;
      minBytes: number;
      hasGit?: boolean;
    },
    prefixes: string[],
    budget: { left: number },
    nextId: () => string,
    volumePath: string,
  ): Promise<InternalItem | null> {
    let info: { realPath: string; identity: string } | null = null;
    try {
      const st = await lstat(target);
      if (st.isSymbolicLink()) return null;
      if (!st.isDirectory() && !st.isFile()) return null;
      const realPath = await realpath(target);
      if (isProtectedPath(realPath, this.env, prefixes)) return null;
      if (!isSafeDeletionTarget(realPath, this.env, prefixes, st.isFile() ? [volumePath] : []))
        return null;
      info = { realPath, identity: diskIdentity(st) };
    } catch {
      return null;
    }
    const allowance = Math.min(budget.left, this.limits.maxEntriesPerItem);
    const perItem = { left: allowance };
    const measured = await measure(
      info.realPath,
      perItem,
      (path) => !isProtectedPath(path, this.env, prefixes),
    );
    budget.left -= allowance - perItem.left;
    if (!measured || (measured.bytes < spec.minBytes && !measured.truncated)) return null;
    const hasGit = spec.hasGit ?? measured.hasGit;
    const ruleTier: DiskTierValue = hasGit || measured.truncated ? "keep" : spec.tier;
    const subject = {
      tier: ruleTier,
      ruleTier,
      category: spec.category,
      regenerable: hasGit ? false : spec.regenerable,
      protected: false,
      locked: hasGit || (spec.locked ?? false),
      hasGit,
    };
    return {
      id: nextId(),
      title: spec.title,
      path: target,
      realPath: info.realPath,
      bytes: measured.bytes,
      tier: applyTierGuard(subject),
      ruleTier,
      category: spec.category,
      reason: hasGit
        ? "包含 Git 仓库，只展示不清理"
        : measured.truncated
          ? "目录未完整检查，仅展示已统计占用"
          : spec.reason,
      mode: spec.mode,
      regenerable: subject.regenerable,
      protected: false,
      locked: subject.locked,
      hasGit,
      daysSinceUsed: daysSince(measured.newestMs),
      truncated: measured.truncated,
      identity: info.identity,
      contentsIdentity: measured.identity,
    };
  }

  private async collectGeneric(consider: Consider, prefixes: string[]): Promise<void> {
    for (const root of genericCacheRoots(this.env)) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const target = join(root, entry.name);
        if (isProtectedPath(target, this.env, prefixes)) continue;
        await consider(target, {
          title: entry.name,
          category: "app",
          tier: "optional",
          mode: "contents",
          regenerable: false,
          locked: true,
          reason: "应用缓存。删除后第一次打开会稍慢，一般不影响账号和文件",
          minBytes: this.limits.genericMinBytes,
        });
      }
    }
  }

  private async collectUserFiles(consider: Consider): Promise<void> {
    for (const root of userContentRoots(this.env)) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.name === "$RECYCLE.BIN" || entry.name === "System Volume Information") continue;
        const target = join(root.path, entry.name);
        let file = false;
        try {
          const st = await lstat(target);
          if (st.isSymbolicLink()) continue;
          file = st.isFile();
          if (!file && !st.isDirectory()) continue;
        } catch {
          continue;
        }
        if (!file && (await existsDir(join(target, ".git")))) continue;
        await consider(target, {
          title: entry.name,
          category: "user",
          tier: "optional",
          mode: "whole",
          regenerable: false,
          locked: true,
          minBytes: file ? this.limits.largeFileMinBytes : this.limits.largeDirMinBytes,
          reason: `${root.label}里的${file ? "大文件" : "大文件夹"}。确认不再需要后再清理`,
        });
      }
    }
  }

  private async trashItem(nextId: () => string, status: DiskStatus): Promise<InternalItem | null> {
    if (this.env.platform === "win32") {
      const state = await windowsRecycleState(status.volumePath);
      if (!state || state.bytes < this.limits.knownMinBytes) return null;
      return {
        ...this.recycleItem(
          nextId(),
          `${status.volumePath} 回收站`,
          join(status.volumePath, "$RECYCLE.BIN"),
          state.bytes,
          `回收站包含 ${state.items} 项。清空后无法从资源管理器找回`,
        ),
        contentsIdentity: String(state.items),
      };
    }
    if (this.env.platform !== "darwin" || !status.isHome) return null;
    const trash = join(this.env.home, ".Trash");
    try {
      const st = await lstat(trash);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
      const realPath = await realpath(trash);
      if (pathKey(realPath, "darwin") !== pathKey(trash, "darwin")) return null;
      const measured = await measure(realPath, { left: this.limits.maxEntriesPerItem });
      if (!measured || measured.truncated || measured.bytes < this.limits.knownMinBytes)
        return null;
      return {
        ...this.recycleItem(
          nextId(),
          "废纸篓",
          trash,
          measured.bytes,
          "清空废纸篓后，里面的文件将无法找回",
        ),
        contentsIdentity: measured.identity,
      };
    } catch {
      return null;
    }
  }

  private recycleItem(
    id: string,
    title: string,
    path: string,
    bytes: number,
    reason: string,
  ): InternalItem {
    return {
      id,
      title,
      path,
      realPath: path,
      bytes,
      tier: "optional",
      ruleTier: "optional",
      category: "system",
      reason,
      mode: "recycle",
      regenerable: false,
      protected: false,
      locked: true,
      hasGit: false,
      daysSinceUsed: null,
      truncated: false,
    };
  }

  private async cleanOne(
    item: InternalItem,
    action: "trash" | "delete",
    volumePath: string,
    volumes: DiskVolume[],
  ): Promise<{ ok: true; action: "delete" | "trash" } | { ok: false; reason: string }> {
    if (item.tier === "keep" || item.protected || item.hasGit) {
      return { ok: false, reason: "这一项只展示，不会清理" };
    }
    if (item.mode === "recycle") {
      const bytes = await this.readTrashBytes(volumePath, item);
      if (bytes !== item.bytes) return { ok: false, reason: "回收站内容已变化，请重新扫描" };
      const emptied = await this.emptyTrash(volumePath);
      return emptied.ok ? { ok: true, action: "delete" } : { ok: false, reason: emptied.reason };
    }
    let realPath: string;
    let isFile = false;
    try {
      const st = await lstat(item.path);
      if (st.isSymbolicLink()) return { ok: false, reason: "路径是符号链接，已跳过" };
      if (diskIdentity(st) !== item.identity)
        return { ok: false, reason: "扫描后项目发生变化，请重新扫描" };
      isFile = st.isFile();
      realPath = await realpath(item.path);
    } catch {
      return { ok: false, reason: "路径已经不存在" };
    }
    if (pathKey(realPath, this.env.platform) !== pathKey(item.realPath, this.env.platform)) {
      return { ok: false, reason: "扫描后路径发生了变化" };
    }
    const owner = volumeForPath(
      realPath,
      volumes.map((volume) => ({ path: volume.volumePath, label: volume.label })),
      this.env,
    );
    if (!owner || pathKey(owner.path, this.env.platform) !== pathKey(volumePath, this.env.platform))
      return { ok: false, reason: "目标所在磁盘已变化" };
    const prefixes = this.prefixes();
    if (
      !isSafeDeletionTarget(realPath, this.env, prefixes, isFile ? [volumePath] : []) ||
      isProtectedPath(realPath, this.env, prefixes)
    ) {
      return { ok: false, reason: "路径不在允许清理的范围内" };
    }
    if (!isFile) {
      const measured = await measure(
        realPath,
        { left: this.limits.maxEntriesPerItem },
        (path) =>
          !isProtectedPath(path, this.env, prefixes) &&
          !volumes.some(
            (volume) =>
              volume.volumePath !== volumePath &&
              pathKey(path, this.env.platform) === pathKey(volume.volumePath, this.env.platform),
          ),
      );
      if (!measured || measured.hasGit || measured.truncated) {
        return { ok: false, reason: "目录包含受保护内容或未完整检查，请重新扫描" };
      }
      if (measured.identity !== item.contentsIdentity)
        return { ok: false, reason: "扫描后目录内容发生变化，请重新扫描" };
    }
    try {
      if (action === "trash") {
        await moveToTrash(realPath, this.env.platform);
        return { ok: true, action: "trash" };
      }
      if (item.mode === "contents") await removeContents(realPath);
      else await rm(realPath, { recursive: !isFile });
      return { ok: true, action: "delete" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      return { ok: false, reason: message };
    }
  }

  private async readTrashBytes(volumePath: string, item: InternalItem): Promise<number | null> {
    if (this.env.platform === "win32") {
      const state = await windowsRecycleState(volumePath);
      return state && String(state.items) === item.contentsIdentity ? state.bytes : null;
    }
    if (this.env.platform !== "darwin") return null;
    const measured = await measure(item.path, { left: this.limits.maxEntriesPerItem });
    return measured && !measured.truncated && measured.identity === item.contentsIdentity
      ? measured.bytes
      : null;
  }

  private async emptyTrash(
    volumePath: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      if (this.env.platform === "win32") {
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Clear-RecycleBin -DriveLetter $env:AGENTDESK_RECYCLE_DRIVE -Force -ErrorAction Stop",
          ],
          {
            windowsHide: true,
            timeout: 60_000,
            env: { ...process.env, AGENTDESK_RECYCLE_DRIVE: volumePath[0] },
          },
        );
        return { ok: true };
      }
      if (this.env.platform === "darwin") {
        const trash = join(this.env.home, ".Trash");
        const realPath = await realpath(trash);
        if (pathKey(realPath, "darwin") !== pathKey(trash, "darwin")) {
          return { ok: false, reason: "废纸篓路径异常" };
        }
        await removeContents(realPath);
        return { ok: true };
      }
      return { ok: false, reason: "当前系统没有回收站清理" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法清空回收站";
      return { ok: false, reason: message };
    }
  }

  private prefixes(): string[] {
    return protectedPrefixes(this.env, this.extraProtected);
  }

  private freshScan(): StoredScan | null {
    if (!this.latest) return null;
    if (Date.now() - this.latest.at > SCAN_TTL_MS) {
      this.latest = null;
      return null;
    }
    return this.latest;
  }

  private requireScan(scanId: string): StoredScan {
    const scan = this.freshScan();
    if (!scan || scan.id !== scanId) {
      throw new AppError(ErrorCode.BadRequest, "扫描结果已过期，请重新扫描");
    }
    return scan;
  }

  private toPublic(scan: StoredScan): DiskScan {
    const items = scan.items.map(toCandidate);
    const primaryBytes = sum(scan.items.filter((item) => item.tier === "primary"));
    const optionalBytes = sum(scan.items.filter((item) => item.tier === "optional"));
    return {
      id: scan.id,
      scannedAt: new Date(scan.at).toISOString(),
      status: scan.status,
      summary: `${scan.status.volumePath}：${summarize(scan.items, scan.partial)}${scan.usage[0] ? `。已统计的最大占用是「${scan.usage[0].title}」，约 ${formatBytes(scan.usage[0].bytes)}` : ""}`,
      items,
      usage: scan.usage,
      primaryBytes,
      optionalBytes,
      partial: scan.partial,
    };
  }
}

function diskIdentity(stat: Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

async function inspectDiskRepository(directory: string): Promise<DiskDirectoryUsage["git"]> {
  const marker = await lstat(join(directory, ".git")).catch(() => undefined);
  if (!marker?.isDirectory() && !marker?.isFile()) return undefined;
  try {
    const options = { timeout: 2500, windowsHide: true, maxBuffer: 256 * 1024 };
    const config = await execFileAsync(
      "git",
      ["-C", directory, "config", "--name-only", "--null", "--list"],
      options,
    );
    // status 可能调用仓库配置的外部 clean filter。遇到这种仓库只报告无法核对。
    if (config.stdout.split("\0").some((key) => key.startsWith("filter."))) return null;
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=",
        "-C",
        directory,
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
      options,
    );
    const lines = stdout.split("\n");
    const ahead = /^# branch\.ab \+(\d+) -\d+\r?$/m.exec(stdout);
    return {
      dirty: lines.some((line) => /^[12u?] /.test(line)),
      ahead: ahead ? Number(ahead[1]) : null,
    };
  } catch {
    return null;
  }
}

type Consider = (
  target: string,
  spec: {
    title: string;
    category: DiskCategory;
    tier: DiskTierValue;
    mode: DiskMode;
    regenerable: boolean;
    reason: string;
    locked?: boolean;
    minBytes: number;
    hasGit?: boolean;
  },
) => Promise<void>;

function toCandidate(item: InternalItem): DiskCandidate {
  return {
    id: item.id,
    title: item.title,
    path: item.path,
    bytes: item.bytes,
    tier: item.tier,
    category: item.category,
    reason: item.reason,
    mode: item.mode,
    regenerable: item.regenerable,
    protected: item.protected,
    selectable: item.tier !== "keep" && !item.protected,
    daysSinceUsed: item.daysSinceUsed,
    truncated: item.truncated,
  };
}

function sum(items: InternalItem[]): number {
  return items.reduce((total, item) => total + item.bytes, 0);
}

function summarize(items: InternalItem[], partial: boolean): string {
  const primary = sum(items.filter((item) => item.tier === "primary"));
  const optional = sum(items.filter((item) => item.tier === "optional"));
  const head = [...items]
    .filter((item) => item.tier !== "keep")
    .sort((a, b) => b.bytes - a.bytes)[0];
  let text = `可重建缓存约 ${formatBytes(primary)}，另有 ${formatBytes(optional)} 需要你决定`;
  if (head && head.bytes > 0) text += `，最大项是「${head.title}」`;
  if (partial) text += "。部分目录未完整统计";
  return text;
}

function daysSince(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

async function existsDir(target: string): Promise<boolean> {
  try {
    const st = await lstat(target);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

async function measure(
  target: string,
  budget: { left: number },
  canRead: (path: string) => boolean = () => true,
): Promise<Measured | null> {
  let rootStat;
  try {
    rootStat = await lstat(target);
  } catch {
    return null;
  }
  if (rootStat.isSymbolicLink()) return null;
  if (rootStat.isFile()) {
    budget.left -= 1;
    return {
      bytes: rootStat.size,
      newestMs: rootStat.mtimeMs,
      truncated: false,
      hasGit: false,
      identity: diskIdentity(rootStat),
    };
  }
  if (!rootStat.isDirectory()) return null;
  let bytes = 0;
  let newestMs = rootStat.mtimeMs;
  let truncated = false;
  let hasGit = await existsDir(join(target, ".git"));
  const identity = createHash("sha256").update(diskIdentity(rootStat));
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
      budget.left -= 1;
      if (entry.isSymbolicLink()) {
        truncated = true;
        continue;
      }
      const child = join(dir, entry.name);
      if (entry.name.toLowerCase() === ".git") hasGit = true;
      if (
        !canRead(child) ||
        [".ssh", ".gnupg", ".aws", ".codex", ".claude"].includes(entry.name.toLowerCase())
      ) {
        truncated = true;
        continue;
      }
      try {
        const st = await lstat(child);
        if (st.isSymbolicLink() || st.dev !== rootStat.dev || (!st.isDirectory() && !st.isFile())) {
          truncated = true;
          continue;
        }
        identity.update(JSON.stringify([child, diskIdentity(st)]));
        if (st.isDirectory()) stack.push(child);
        else bytes += st.size;
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      } catch {
        // 被占用或没有权限的文件不计入
        truncated = true;
      }
    }
    if (truncated) break;
  }
  return { bytes, newestMs, truncated, hasGit, identity: identity.digest("hex") };
}

async function removeContents(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    const child = join(dir, entry.name);
    try {
      await rm(child, { recursive: !entry.isSymbolicLink(), force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0)
    throw new Error(
      removed === 0
        ? "文件正在使用，没有删除任何内容"
        : `仅处理了 ${removed} 项，另有 ${failed} 项无法删除`,
    );
}

async function moveToTrash(target: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "Add-Type -AssemblyName Microsoft.VisualBasic",
          "$path = $env:AGENTDESK_TRASH_PATH",
          "if (-not (Test-Path -LiteralPath $path)) { exit 2 }",
          "if ((Get-Item -LiteralPath $path).PSIsContainer) {",
          "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
          "} else {",
          "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
          "}",
        ].join("\n"),
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, AGENTDESK_TRASH_PATH: target },
      },
    );
    return;
  }
  if (platform === "darwin") {
    if (/["\r\n]/.test(target)) throw new Error("路径包含无法安全移交废纸篓的字符");
    await execFileAsync(
      "osascript",
      ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`],
      { timeout: 60_000 },
    );
    return;
  }
  throw new Error("当前系统没有回收站，请在设置里改成直接删除");
}

async function windowsRecycleState(
  volumePath: string,
): Promise<{ bytes: number; items: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AgentDeskRecycle { [StructLayout(LayoutKind.Sequential, Pack=8)] public struct Info { public int cbSize; public long bytes; public long items; } [DllImport(\"shell32.dll\", CharSet=CharSet.Unicode)] public static extern int SHQueryRecycleBin(string root, ref Info info); }'",
          "$info = New-Object AgentDeskRecycle+Info",
          "$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)",
          "if ([AgentDeskRecycle]::SHQueryRecycleBin($env:AGENTDESK_RECYCLE_ROOT, [ref]$info) -ne 0) { exit 1 }",
          "'{0} {1}' -f $info.bytes, $info.items",
        ].join("\n"),
      ],
      {
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, AGENTDESK_RECYCLE_ROOT: volumePath },
      },
    );
    const match = /^(\d+) (\d+)$/.exec(String(stdout).trim());
    if (!match) return null;
    const bytes = Number(match[1]);
    const items = Number(match[2]);
    return Number.isSafeInteger(bytes) && Number.isSafeInteger(items) ? { bytes, items } : null;
  } catch {
    return null;
  }
}

async function firefoxCaches(env: DiskEnv): Promise<string[]> {
  if (env.platform !== "win32") return [];
  const root = join(env.local, "Mozilla", "Firefox", "Profiles");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const cache = join(root, entry.name, "cache2");
    try {
      const st = await lstat(cache);
      if (st.isDirectory() && !st.isSymbolicLink()) found.push(cache);
    } catch {
      // 这个配置档没有 cache2
    }
  }
  return found;
}

async function jetbrainsCaches(env: DiskEnv): Promise<string[]> {
  if (env.platform !== "win32") return [];
  const root = join(env.local, "JetBrains");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    for (const name of ["caches", "tmp"]) {
      const target = join(root, entry.name, name);
      try {
        const st = await lstat(target);
        if (st.isDirectory() && !st.isSymbolicLink()) found.push(target);
      } catch {
        // 该产品没有这个缓存目录
      }
    }
  }
  return found;
}

function openDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export { formatBytes };

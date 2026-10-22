import { execFile, spawn } from "node:child_process";
import { statfsSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import {
  AppError,
  DiskTier,
  ErrorCode,
  type DiskCandidate,
  type DiskCategory,
  type DiskCleanRequest,
  type DiskCleanResult,
  type DiskMode,
  type DiskScan,
  type DiskStatus,
  type DiskTier as DiskTierValue,
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
  isSafeDeletionTarget,
  pathKey,
  protectedPrefixes,
  userContentRoots,
  type DiskEnv,
  type DiskLimits,
  type DiskRule,
} from "./disk-rules";

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
  mtimeMs: number;
}

interface StoredScan {
  id: string;
  at: number;
  partial: boolean;
  items: InternalItem[];
}

interface Measured {
  bytes: number;
  newestMs: number;
  truncated: boolean;
  hasGit: boolean;
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
  private latest: StoredScan | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly providers: ModelResolver,
    options: DiskServiceOptions = {},
  ) {
    this.env = options.env ?? detectDiskEnv();
    this.limits = options.limits ?? DEFAULT_DISK_LIMITS;
    this.extraProtected = options.extraProtected ?? [];
    this.systemTrash = options.systemTrash ?? true;
  }

  status(): DiskStatus {
    let stats: ReturnType<typeof statfsSync>;
    try {
      stats = statfsSync(this.env.home);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取磁盘空间";
      throw new AppError(ErrorCode.IntegrationFailed, message);
    }
    const totalBytes = Math.max(0, Number(stats.blocks) * Number(stats.bsize));
    const freeBytes = Math.max(0, Number(stats.bavail) * Number(stats.bsize));
    const thresholdBytes = this.settings.get().diskThresholdGB * 1024 ** 3;
    const platform = this.env.platform;
    return {
      platform:
        platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other",
      volumePath: this.env.home,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      thresholdBytes,
      low: freeBytes < thresholdBytes,
    };
  }

  current(): DiskScan | null {
    const scan = this.freshScan();
    return scan ? this.toPublic(scan) : null;
  }

  async scan(): Promise<DiskScan> {
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
      if (budget.left <= 0) {
        partial = true;
        return;
      }
      const added = await this.considerPath(target, spec, prefixes, budget, nextId);
      if (!added) return;
      if (added.truncated) partial = true;
      const key = pathKey(added.realPath, this.env.platform);
      if (seen.has(key)) return;
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
    if (this.systemTrash) {
      const trash = await this.trashItem(nextId);
      if (trash) items.push(trash);
    }

    items.sort((a, b) => b.bytes - a.bytes);
    const stored: StoredScan = { id: newId(), at: Date.now(), partial, items };
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
      path: item.path,
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
        prompt: JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型复核失败";
      throw new AppError(ErrorCode.ProviderUnavailable, message);
    }
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

  cleanLatest(ids: string[]): Promise<DiskCleanResult> {
    const scan = this.freshScan();
    if (!scan) throw new AppError(ErrorCode.BadRequest, "请先扫描磁盘");
    return this.clean({ scanId: scan.id, ids });
  }

  async clean(input: DiskCleanRequest): Promise<DiskCleanResult> {
    const scan = this.requireScan(input.scanId);
    const action = this.settings.get().diskOptionalAction;
    const result: DiskCleanResult = { freedBytes: 0, cleaned: [], skipped: [] };
    const wanted = new Set(input.ids);
    for (const id of wanted) {
      const item = scan.items.find((candidate) => candidate.id === id);
      if (!item) {
        result.skipped.push({ id, path: "", reason: "不在本次扫描结果里" });
        continue;
      }
      const outcome = await this.cleanOne(item, action);
      if (outcome.ok) {
        result.cleaned.push({
          id: item.id,
          path: item.path,
          bytes: item.bytes,
          action: outcome.action,
        });
        result.freedBytes += item.bytes;
        item.bytes = 0;
        item.tier = "keep";
      } else {
        result.skipped.push({ id: item.id, path: item.path, reason: outcome.reason });
      }
    }
    return result;
  }

  describeClean(ids: string[]): string {
    const scan = this.freshScan();
    if (!scan) return "还没有扫描结果";
    const lines = ids.slice(0, 30).map((id) => {
      const item = scan.items.find((candidate) => candidate.id === id);
      if (!item) return `${id}：不在扫描结果里`;
      return `${item.title}（${formatBytes(item.bytes)}，${item.tier}） ${item.path}`;
    });
    const action = this.settings.get().diskOptionalAction === "trash" ? "回收站" : "直接删除";
    return `可重建缓存会直接删除；需决定的项按设置进入${action}。\n${lines.join("\n")}`;
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
  ): Promise<InternalItem | null> {
    let info: { realPath: string; mtimeMs: number } | null = null;
    try {
      const st = await lstat(target);
      if (st.isSymbolicLink()) return null;
      if (!st.isDirectory() && !st.isFile()) return null;
      const realPath = await realpath(target);
      if (isProtectedPath(realPath, this.env, prefixes)) return null;
      if (!isSafeDeletionTarget(realPath, this.env, prefixes)) return null;
      info = { realPath, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
    const allowance = Math.min(budget.left, this.limits.maxEntriesPerItem);
    const perItem = { left: allowance };
    const measured = await measure(info.realPath, perItem);
    budget.left -= allowance - perItem.left;
    if (!measured || (measured.bytes < spec.minBytes && !measured.truncated)) return null;
    const hasGit = spec.hasGit ?? measured.hasGit;
    const ruleTier: DiskTierValue = hasGit ? "keep" : spec.tier;
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
      reason: hasGit ? "包含 Git 仓库，只展示不清理" : spec.reason,
      mode: spec.mode,
      regenerable: subject.regenerable,
      protected: false,
      locked: subject.locked,
      hasGit,
      daysSinceUsed: daysSince(measured.newestMs),
      truncated: measured.truncated,
      mtimeMs: info.mtimeMs,
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

  private async trashItem(nextId: () => string): Promise<InternalItem | null> {
    if (this.env.platform === "win32") {
      const bytes = await windowsRecycleBytes();
      if (bytes === null || bytes < this.limits.knownMinBytes) return null;
      return this.recycleItem(
        nextId(),
        "回收站",
        "shell:RecycleBinFolder",
        bytes,
        "清空回收站后，里面的文件将无法从资源管理器找回",
      );
    }
    if (this.env.platform !== "darwin") return null;
    const trash = join(this.env.home, ".Trash");
    try {
      const st = await lstat(trash);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
      const realPath = await realpath(trash);
      if (pathKey(realPath, "darwin") !== pathKey(trash, "darwin")) return null;
      const measured = await measure(realPath, { left: this.limits.maxEntriesPerItem });
      if (!measured || measured.bytes < this.limits.knownMinBytes) return null;
      return this.recycleItem(
        nextId(),
        "废纸篓",
        trash,
        measured.bytes,
        "清空废纸篓后，里面的文件将无法找回",
      );
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
      mtimeMs: 0,
    };
  }

  private async cleanOne(
    item: InternalItem,
    optionalAction: "trash" | "delete",
  ): Promise<{ ok: true; action: "delete" | "trash" } | { ok: false; reason: string }> {
    if (item.tier === "keep" || item.protected || item.hasGit) {
      return { ok: false, reason: "这一项只展示，不会清理" };
    }
    if (item.mode === "recycle") {
      const emptied = await this.emptyTrash();
      return emptied.ok ? { ok: true, action: "delete" } : { ok: false, reason: emptied.reason };
    }
    let realPath: string;
    try {
      const st = await lstat(item.path);
      if (st.isSymbolicLink()) return { ok: false, reason: "路径是符号链接，已跳过" };
      realPath = await realpath(item.path);
    } catch {
      return { ok: false, reason: "路径已经不存在" };
    }
    if (pathKey(realPath, this.env.platform) !== pathKey(item.realPath, this.env.platform)) {
      return { ok: false, reason: "扫描后路径发生了变化" };
    }
    const prefixes = this.prefixes();
    if (
      !isSafeDeletionTarget(realPath, this.env, prefixes) ||
      isProtectedPath(realPath, this.env, prefixes)
    ) {
      return { ok: false, reason: "路径不在允许清理的范围内" };
    }
    const useTrash = item.tier === "optional" && optionalAction === "trash";
    try {
      if (useTrash) {
        await moveToTrash(realPath, this.env.platform);
        return { ok: true, action: "trash" };
      }
      if (item.mode === "contents") await removeContents(realPath);
      else await rm(realPath, { recursive: true, force: true });
      return { ok: true, action: "delete" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      return { ok: false, reason: message };
    }
  }

  private async emptyTrash(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      if (this.env.platform === "win32") {
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Clear-RecycleBin -Force -ErrorAction Stop",
          ],
          { windowsHide: true, timeout: 60_000 },
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
      status: this.status(),
      summary: summarize(scan.items, scan.partial),
      items,
      primaryBytes,
      optionalBytes,
      partial: scan.partial,
    };
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

async function measure(target: string, budget: { left: number }): Promise<Measured | null> {
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
    };
  }
  if (!rootStat.isDirectory()) return null;
  let bytes = 0;
  let newestMs = rootStat.mtimeMs;
  let truncated = false;
  const hasGit = await existsDir(join(target, ".git"));
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
      budget.left -= 1;
      if (entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = await lstat(child);
        bytes += st.size;
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      } catch {
        // 被占用或没有权限的文件不计入
      }
    }
    if (truncated) break;
  }
  return { bytes, newestMs, truncated, hasGit };
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
  if (removed === 0 && failed > 0) throw new Error("文件正在使用，没有删除任何内容");
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

async function windowsRecycleBytes(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$sum = (New-Object -ComObject Shell.Application).NameSpace(10).Items() | Measure-Object -Property Size -Sum | Select-Object -ExpandProperty Sum; if ($null -eq $sum) { 0 } else { [int64]$sum }",
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const value = Number(String(stdout).trim());
    return Number.isFinite(value) ? value : null;
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

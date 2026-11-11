import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, statfs, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AppError,
  ErrorCode,
  StoragePolicy,
  type StorageCleanupPreview,
  type StorageCleanupResult,
  type StorageUsage,
  type StorageUsageItem,
} from "@agentdesk/shared";
import { Collection } from "../../db/collection";
import type { Db } from "../../db/client";
import { conversationActivity } from "../conversation-activity";
import type { TaskService } from "../tasks";
import type { RetentionStore } from "./ports";

const DAY = 86_400_000;
const GiB = 1024 ** 3;
const MAX_FILES = 10_000;
type Candidate = { path: string; bytes: number; mtimeMs: number; ino: number; dev: number };
type Plan = {
  preview: StorageCleanupPreview;
  files: Candidate[];
  taskIds: string[];
  policy: string;
  eventCutoff: string;
  traceCutoff: string;
  screenshotCutoff: number;
};

export class StorageService {
  private readonly policies: Collection<StoragePolicy & { id: string }>;
  private readonly plans = new Map<string, Plan>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<StorageCleanupResult>;
  private measurement?: Promise<StorageUsage>;
  private lastAutomaticError = false;
  private stopping = false;
  private automatic?: Promise<void>;

  constructor(
    db: Db,
    private readonly dataDir: string,
    private readonly tasks: TaskService,
    private readonly store: RetentionStore,
    private readonly screenshotsBusy: () => boolean,
  ) {
    this.policies = new Collection(db, "storagePolicies");
  }

  policy(): StoragePolicy {
    return StoragePolicy.parse(this.policies.get("local") ?? {});
  }

  updatePolicy(value: unknown): StoragePolicy {
    const policy = StoragePolicy.parse(value);
    this.policies.put({ id: "local", ...policy });
    this.plans.clear();
    return policy;
  }

  start(): void {
    if (this.timer) return;
    // 不在启动瞬间删除旧记录；先让任务恢复和订阅完成。默认不开启自动回收。
    this.timer = setInterval(() => {
      if (this.stopping || !this.policy().automaticCleanup || this.running || this.automatic)
        return;
      this.automatic = this.preview()
        .then((p) => this.cleanup(p.id))
        .then(() => undefined)
        .catch(() => {
          this.lastAutomaticError = true;
          console.warn("[storage] Automatic cleanup failed; inspect storage settings");
        })
        .finally(() => {
          this.automatic = undefined;
        });
    }, 60 * 60_000);
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.automatic;
    await this.running;
    this.plans.clear();
  }

  private async disk(path: string) {
    const info = await statfs(path);
    const policy = this.policy();
    const totalBytes = info.blocks * info.bsize;
    return {
      totalBytes,
      freeBytes: info.bavail * info.bsize,
      reserveBytes: Math.max(policy.reserveGiB * GiB, (totalBytes * policy.reservePercent) / 100),
    };
  }

  async assertWritable(workspace?: string): Promise<void> {
    for (const path of new Set([this.dataDir, ...(workspace ? [workspace] : [])])) {
      let disk;
      try {
        disk = await this.disk(path);
      } catch {
        throw new AppError(
          ErrorCode.ServiceUnavailable,
          "无法核实任务目录的剩余空间，请检查存储设置。",
        );
      }
      if (disk.freeBytes < disk.reserveBytes)
        throw new AppError(
          ErrorCode.StorageFull,
          "磁盘剩余空间低于存储预留值，请清理空间或调整存储设置后再启动任务。",
        );
    }
  }

  usage(): Promise<StorageUsage> {
    // 合并并发请求，避免页面轮询重复遍历。
    return (this.measurement ??= this.measure().finally(() => {
      this.measurement = undefined;
    }));
  }

  private async measure(): Promise<StorageUsage> {
    let remaining = MAX_FILES;
    const visit = async (
      path: string,
    ): Promise<{ bytes: number; files: number; incomplete: boolean }> => {
      if (--remaining < 0) return { bytes: 0, files: 0, incomplete: true };
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) return { bytes: 0, files: 0, incomplete: true };
        if (!info.isDirectory()) return { bytes: info.size, files: 1, incomplete: false };
        const sum = { bytes: 0, files: 0, incomplete: false };
        for (const name of await readdir(path)) {
          const child = await visit(join(path, name));
          sum.bytes += child.bytes;
          sum.files += child.files;
          sum.incomplete ||= child.incomplete;
          if (remaining < 0) break;
        }
        return sum;
      } catch {
        return { bytes: 0, files: 0, incomplete: true };
      }
    };
    const items: StorageUsageItem[] = [];
    const warnings: string[] = [];
    let inaccessible = false;
    try {
      for (const name of await readdir(this.dataDir)) {
        const size = await visit(join(this.dataDir, name));
        items.push({ name, ...size, protected: name !== "browser-shots" });
      }
    } catch {
      inaccessible = true;
      warnings.push("无法完整读取数据目录，用量仅包含可访问部分。");
    }
    let disk = null;
    try {
      disk = await this.disk(this.dataDir);
    } catch {
      warnings.push("无法读取分区剩余空间。");
    }
    if (items.some((x) => x.incomplete))
      warnings.push("存在不可访问目录、链接或扫描上限，用量为已测部分下界。");
    if (disk && disk.freeBytes < disk.reserveBytes)
      warnings.push("剩余空间低于预留值，新任务和新截图已受到限制。");
    if (
      (items.find((x) => x.name === "browser-shots")?.bytes ?? 0) >
      this.policy().cacheLimitMiB * 1024 ** 2
    )
      warnings.push("截图缓存超过软上限；仅回收符合留存策略且无引用的旧截图。");
    if (this.lastAutomaticError) warnings.push("最近一次自动清理失败，请重新预览并检查结果。");
    return {
      measuredAt: new Date().toISOString(),
      dataDir: this.dataDir,
      items,
      totalBytes: items.reduce((sum, x) => sum + x.bytes, 0),
      incomplete: inaccessible || items.some((x) => x.incomplete) || remaining < 0 || !disk,
      disk,
      warnings,
    };
  }

  private eligibleTasks(cutoff: string) {
    const all = this.tasks.list();
    const activeConversations = new Set(
      all.filter((task) => task.status !== "closed").map((task) => task.conversationId),
    );
    return all.filter((task) => {
      if (
        task.status !== "closed" ||
        !task.closedAt ||
        task.closedAt >= cutoff ||
        task.pendingApprovalId ||
        this.tasks.isHistoryInUse(task.id) ||
        conversationActivity(task.conversationId) ||
        this.store.hasPendingApproval(task.id, task.conversationId)
      )
        return false;
      if (activeConversations.has(task.conversationId)) return false;
      return this.tasks
        .listRuns(task.id)
        .every(
          (run) =>
            ["succeeded", "failed", "cancelled"].includes(run.status) &&
            !!run.endedAt &&
            run.endedAt < cutoff,
        );
    });
  }

  private filesBusy(): boolean {
    return (
      this.screenshotsBusy() ||
      this.tasks
        .list()
        .some((task) => !["completed", "failed", "cancelled", "closed"].includes(task.status))
    );
  }

  private async candidates(cutoff: number): Promise<Candidate[]> {
    if (this.filesBusy()) return [];
    const root = join(this.dataDir, "browser-shots");
    const files: Candidate[] = [];
    let inspected = 0;
    try {
      if ((await lstat(root)).isSymbolicLink()) return [];
      for (const session of await readdir(root)) {
        if (++inspected > 5000) break;
        const dir = join(root, session);
        const parent = await lstat(dir);
        if (!parent.isDirectory() || parent.isSymbolicLink()) continue;
        for (const name of await readdir(dir)) {
          if (++inspected > 5000) return files;
          if (!name.endsWith(".png")) continue;
          const path = join(dir, name);
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.mtimeMs >= cutoff ||
            this.store.referencesFile(name)
          )
            continue;
          files.push({
            path,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
            ino: info.ino,
            dev: info.dev,
          });
          if (files.length >= 500) return files;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return files;
  }

  async preview(): Promise<StorageCleanupPreview> {
    const now = Date.now();
    const policy = this.policy();
    const eventCutoff = new Date(now - policy.eventDays * DAY).toISOString();
    const traceCutoff = new Date(now - policy.traceDays * DAY).toISOString();
    // 同批日志和事件采用更长的任务保留期，避免为了日志提前清除任务历史。
    const tasks = this.eligibleTasks(eventCutoff < traceCutoff ? eventCutoff : traceCutoff)
      .filter((task) => {
        const count = this.store.count([task.id], [task.conversationId], eventCutoff, traceCutoff);
        return count.events + count.traces > 0;
      })
      .slice(0, 20);
    const screenshotCutoff = now - policy.screenshotDays * DAY;
    const files = await this.candidates(screenshotCutoff);
    const counts = this.store.count(
      tasks.map((t) => t.id),
      tasks.map((t) => t.conversationId),
      eventCutoff,
      traceCutoff,
    );
    const preview: StorageCleanupPreview = {
      id: randomUUID(),
      expiresAt: new Date(now + 300_000).toISOString(),
      files: files.length,
      fileBytes: files.reduce((n, f) => n + f.bytes, 0),
      ...counts,
      warnings: [
        "仅回收已关闭任务的旧事件/聊天轨迹和无引用旧截图；不删除项目、产物、密钥或浏览器登录态。",
        "每批最多 500 个文件、20 个任务，每任务最多 1,000 条事件和轨迹。数据库文件不会立即缩小。",
      ],
    };
    this.plans.clear();
    this.plans.set(preview.id, {
      preview,
      files,
      taskIds: tasks.map((t) => t.id),
      policy: JSON.stringify(policy),
      eventCutoff,
      traceCutoff,
      screenshotCutoff,
    });
    return preview;
  }

  cleanup(id: string): Promise<StorageCleanupResult> {
    if (this.stopping) throw new AppError(ErrorCode.ServiceUnavailable, "存储服务正在关闭。");
    if (this.running) throw new AppError(ErrorCode.Conflict, "已有清理正在进行。");
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (
      !plan ||
      plan.preview.expiresAt <= new Date().toISOString() ||
      plan.policy !== JSON.stringify(this.policy())
    )
      throw new AppError(ErrorCode.StalePreview, "清理预览已失效，请重新预览。");
    this.running = this.apply(plan).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async apply(plan: Plan): Promise<StorageCleanupResult> {
    const result: StorageCleanupResult = {
      files: 0,
      fileBytes: 0,
      events: 0,
      traces: 0,
      skipped: 0,
      completedAt: "",
    };
    const root = join(await realpath(this.dataDir), "browser-shots");
    for (const file of plan.files) {
      if (this.stopping || JSON.stringify(this.policy()) !== plan.policy || this.filesBusy()) {
        result.skipped++;
        continue;
      }
      try {
        const actual = await realpath(file.path);
        const rel = relative(root, actual);
        if (
          isAbsolute(rel) ||
          rel.startsWith(`..${sep}`) ||
          rel === ".." ||
          resolve(root, rel) !== actual ||
          rel.split(sep).length !== 2 ||
          (await lstat(join(this.dataDir, "browser-shots"))).isSymbolicLink() ||
          (await lstat(join(this.dataDir, "browser-shots", rel.split(sep)[0]!))).isSymbolicLink()
        ) {
          result.skipped++;
          continue;
        }
        const info = await lstat(file.path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== file.bytes ||
          info.mtimeMs !== file.mtimeMs ||
          info.ino !== file.ino ||
          info.dev !== file.dev ||
          info.mtimeMs >= plan.screenshotCutoff ||
          this.filesBusy() ||
          this.store.referencesFile(basename(file.path))
        ) {
          result.skipped++;
          continue;
        }
        await unlink(file.path);
        result.files++;
        result.fileBytes += file.bytes;
      } catch {
        result.skipped++;
      }
    }
    const traced = new Set<string>();
    for (const taskId of plan.taskIds) {
      const cutoff = plan.eventCutoff < plan.traceCutoff ? plan.eventCutoff : plan.traceCutoff;
      const task =
        !this.stopping && JSON.stringify(this.policy()) === plan.policy
          ? this.eligibleTasks(cutoff).find((t) => t.id === taskId)
          : undefined;
      if (!task) {
        result.skipped++;
        continue;
      }
      const deleted = this.store.prune(
        taskId,
        traced.has(task.conversationId) ? "" : task.conversationId,
        plan.eventCutoff,
        plan.traceCutoff,
      );
      traced.add(task.conversationId);
      result.events += deleted.events;
      result.traces += deleted.traces;
      await new Promise<void>((done) => setImmediate(done));
    }
    if (result.events || result.traces) this.store.checkpoint();
    result.completedAt = new Date().toISOString();
    this.lastAutomaticError = false;
    return result;
  }
}

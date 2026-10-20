import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { localDate, localTime } from "../util";
import type { FeedService } from "./feed";
import type { SettingsService } from "./settings";
import type { WorkflowService } from "./workflows";

type JobState = { id: string; lastRunDate: string };

/**
 * 分钟级调度：
 * - 每日热榜：到达设置时间后刷新并生成速览；错过时间（电脑休眠/未开机）则在下次启动后补跑。
 * - 定时工作流：按 trigger.time 触发。
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly jobs: Collection<JobState>;

  constructor(
    db: Db,
    private readonly settings: SettingsService,
    private readonly feed: FeedService,
    private readonly workflows: WorkflowService,
  ) {
    this.jobs = new Collection<JobState>(db, "schedulerJobs");
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    const today = localDate(now);
    const time = localTime(now);
    const feedJob = this.jobs.get("feed");
    if (feedJob?.lastRunDate !== today && time >= this.settings.get().feedSchedule) {
      this.jobs.put({ id: "feed", lastRunDate: today });
      try {
        const result = await this.feed.refresh();
        if (result.fetched > 0) await this.feed.generateDigest(today).catch(() => null);
      } catch (error) {
        console.error("[scheduler] feed refresh failed", error);
      }
    }
    try {
      this.workflows.tickSchedules(time, today);
    } catch (error) {
      console.error("[scheduler] workflow schedule failed", error);
    }
  }
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export type BrowserChannel = "msedge" | "chrome";

interface SessionEntry {
  context: BrowserContext;
  headless: boolean;
}

/**
 * 通用持久化浏览器会话：按 sessionId 隔离 profile（Cookie 跨次复用）。
 * 宝塔用 `deploy:{serverId}`，Agent 用 `agent:{id}` / 业务名如 `zentao`。
 * 需要人工介入时以有头模式重开同一目录。
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly profileRoot: string,
    private readonly channel: () => BrowserChannel,
  ) {}

  /** @param sessionId 会话键；历史宝塔代码仍传 serverId，语义相同 */
  async page(sessionId: string, options: { headless: boolean }): Promise<Page> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.headless !== options.headless) {
      await existing.context.close().catch(() => {});
      this.sessions.delete(sessionId);
    }
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const dir = join(this.profileRoot, sanitizeSessionDir(sessionId));
      await mkdir(dir, { recursive: true });
      const context = await chromium.launchPersistentContext(dir, {
        channel: this.channel(),
        headless: options.headless,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      });
      context.on("close", () => this.sessions.delete(sessionId));
      entry = { context, headless: options.headless };
      this.sessions.set(sessionId, entry);
    }
    const pages = entry.context.pages();
    return pages[0] ?? (await entry.context.newPage());
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listOpen(): string[] {
    return [...this.sessions.keys()];
  }

  async close(sessionId: string): Promise<void> {
    await this.sessions
      .get(sessionId)
      ?.context.close()
      .catch(() => {});
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

function sanitizeSessionDir(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

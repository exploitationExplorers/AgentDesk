import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export type BrowserChannel = "msedge" | "chrome";

interface SessionEntry {
  context: BrowserContext;
  headless: boolean;
}

/**
 * 每台宝塔服务器一个持久化浏览器目录，登录 Cookie 跨次复用；
 * 需要人工介入（验证码、二次验证）时以有头模式重新打开同一目录。
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly profileRoot: string,
    private readonly channel: () => BrowserChannel,
  ) {}

  async page(serverId: string, options: { headless: boolean }): Promise<Page> {
    const existing = this.sessions.get(serverId);
    if (existing && existing.headless !== options.headless) {
      await existing.context.close().catch(() => {});
      this.sessions.delete(serverId);
    }
    let entry = this.sessions.get(serverId);
    if (!entry) {
      const dir = join(this.profileRoot, serverId);
      await mkdir(dir, { recursive: true });
      const context = await chromium.launchPersistentContext(dir, {
        channel: this.channel(),
        headless: options.headless,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      });
      context.on("close", () => this.sessions.delete(serverId));
      entry = { context, headless: options.headless };
      this.sessions.set(serverId, entry);
    }
    const pages = entry.context.pages();
    return pages[0] ?? (await entry.context.newPage());
  }

  async close(serverId: string): Promise<void> {
    await this.sessions
      .get(serverId)
      ?.context.close()
      .catch(() => {});
    this.sessions.delete(serverId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

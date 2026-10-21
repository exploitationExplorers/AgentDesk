import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BrowserSessionManager } from "@agentdesk/integrations";
import {
  browserAct,
  browserIframeText,
  browserTextSnapshot,
  writeScreenshotFile,
} from "@agentdesk/integrations";
import {
  AppError,
  ErrorCode,
  type BrowserActionInput,
  type BrowserSessionEvent,
  type BrowserSessionState,
} from "@agentdesk/shared";
import type { EventHub } from "../events";
import { nowIso } from "../util";

export const browserChannel = (sessionId: string) => `browser:${sessionId}`;

/**
 * Agent / 工作流用的通用浏览器会话：Playwright 控制 + 截图落盘 + EventHub 实况帧。
 * 与宝塔 DeployService 共用同一 BrowserSessionManager 实例（profile 目录隔离）。
 */
export class BrowserService {
  private readonly states = new Map<string, BrowserSessionState>();
  private readonly shotRoot: string;

  constructor(
    readonly manager: BrowserSessionManager,
    private readonly hub: EventHub,
    private readonly dataDir: string,
  ) {
    this.shotRoot = join(dataDir, "browser-shots");
  }

  list(): BrowserSessionState[] {
    return [...this.states.values()].filter((s) => s.open);
  }

  get(id: string): BrowserSessionState {
    const s = this.states.get(id);
    if (!s?.open) throw new AppError(ErrorCode.NotFound, `浏览器会话不存在：${id}`);
    return s;
  }

  async open(input: {
    sessionId?: string;
    url?: string;
    headless?: boolean;
  }): Promise<BrowserSessionState> {
    const id = (input.sessionId?.trim() || `agent-${Date.now().toString(36)}`).slice(0, 80);
    const headless = input.headless ?? true;
    this.hub.retain(browserChannel(id));
    const page = await this.manager.page(id, { headless });
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    const state = await this.captureState(id, headless, true);
    this.publishSession(state);
    await this.publishFrame(id);
    return state;
  }

  async act(
    sessionId: string,
    action: BrowserActionInput,
  ): Promise<{
    result: Awaited<ReturnType<typeof browserAct>>;
    session: BrowserSessionState;
  }> {
    const prev = this.states.get(sessionId);
    const headless = action.headless ?? prev?.headless ?? true;
    const page = await this.manager.page(sessionId, { headless });
    const shotDir = join(this.shotRoot, sanitize(sessionId));
    const result = await browserAct(page, {
      kind: action.kind,
      target: action.target,
      value: action.value,
      timeoutMs: action.timeoutMs,
      shotDir,
      shotName: `act-${Date.now()}.png`,
    });
    const session = await this.captureState(sessionId, headless, true, result.shotPath);
    this.publishSession(session);
    if (action.kind !== "screenshot") await this.publishFrame(sessionId);
    else this.publishFrameFrom(session);
    return { result, session };
  }

  async snapshot(sessionId: string): Promise<{
    url: string;
    title: string;
    text: string;
    iframeText: string | null;
    shotUrl: string | null;
  }> {
    const state = this.get(sessionId);
    const page = await this.manager.page(sessionId, { headless: state.headless });
    const text = await browserTextSnapshot(page);
    const iframeText = await browserIframeText(page);
    await this.publishFrame(sessionId);
    const next = this.get(sessionId);
    return {
      url: next.url,
      title: next.title,
      text,
      iframeText,
      shotUrl: next.lastShotUrl,
    };
  }

  /** 有头弹出同一 profile，便于验证码等人工操作 */
  async reveal(sessionId: string): Promise<BrowserSessionState> {
    this.get(sessionId);
    const page = await this.manager.page(sessionId, { headless: false });
    const url = page.url();
    if (!url || url === "about:blank") {
      /* keep */
    }
    const state = await this.captureState(sessionId, false, true);
    this.publishSession(state);
    await this.publishFrame(sessionId);
    return state;
  }

  async close(sessionId: string): Promise<void> {
    await this.manager.close(sessionId);
    const prev = this.states.get(sessionId);
    if (prev) {
      const closed = { ...prev, open: false, updatedAt: nowIso() };
      this.states.set(sessionId, closed);
      this.hub.publish(browserChannel(sessionId), {
        type: "closed",
        sessionId,
      } satisfies BrowserSessionEvent);
    }
  }

  resolveShotPath(sessionId: string, file: string): string {
    const base = resolve(this.shotRoot, sanitize(sessionId));
    const full = resolve(base, basename(file));
    if (!full.startsWith(base) || !existsSync(full)) {
      throw new AppError(ErrorCode.NotFound, "截图不存在");
    }
    return full;
  }

  private async captureState(
    id: string,
    headless: boolean,
    open: boolean,
    shotPath?: string | null,
  ): Promise<BrowserSessionState> {
    let url = "";
    let title = "";
    if (open && this.manager.isOpen(id)) {
      try {
        const page = await this.manager.page(id, { headless });
        url = page.url();
        title = await page.title().catch(() => "");
      } catch {
        /* session racing close */
      }
    }
    const lastShotPath = shotPath ?? this.states.get(id)?.lastShotPath ?? null;
    const state: BrowserSessionState = {
      id,
      url,
      title,
      headless,
      open,
      lastShotPath,
      lastShotUrl: lastShotPath ? shotApiUrl(id, lastShotPath) : null,
      updatedAt: nowIso(),
    };
    this.states.set(id, state);
    return state;
  }

  private publishSession(session: BrowserSessionState): void {
    this.hub.publish(browserChannel(session.id), {
      type: "session",
      session,
    } satisfies BrowserSessionEvent);
  }

  private async publishFrame(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state?.open) return;
    try {
      const page = await this.manager.page(sessionId, { headless: state.headless });
      const shotPath = await writeScreenshotFile(
        page,
        join(this.shotRoot, sanitize(sessionId)),
        `live-${Date.now()}.png`,
      );
      const next = await this.captureState(sessionId, state.headless, true, shotPath);
      this.publishFrameFrom(next);
      this.publishSession(next);
    } catch {
      /* ignore frame errors */
    }
  }

  private publishFrameFrom(session: BrowserSessionState): void {
    this.hub.publish(browserChannel(session.id), {
      type: "frame",
      sessionId: session.id,
      url: session.url,
      title: session.title,
      shotUrl: session.lastShotUrl,
    } satisfies BrowserSessionEvent);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

function shotApiUrl(sessionId: string, absPath: string): string {
  return `/api/browser/sessions/${encodeURIComponent(sessionId)}/shots/${encodeURIComponent(basename(absPath))}`;
}

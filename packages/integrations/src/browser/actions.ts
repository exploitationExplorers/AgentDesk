import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";

export type BrowserActKind =
  "goto" | "click" | "fill" | "press" | "wait" | "evaluate" | "screenshot";

export interface BrowserActInput {
  kind: BrowserActKind;
  /** CSS 选择器或 URL / 按键 / JS 表达式 */
  target?: string;
  value?: string;
  timeoutMs?: number;
  /** screenshot 时写入的目录 */
  shotDir?: string;
  shotName?: string;
}

export interface BrowserActResult {
  url: string;
  title: string;
  /** evaluate 返回值或文本摘要 */
  value?: unknown;
  /** 截图绝对路径 */
  shotPath?: string;
}

/** 在已打开的 Page 上执行一步操作 */
export async function browserAct(page: Page, input: BrowserActInput): Promise<BrowserActResult> {
  const timeout = input.timeoutMs ?? 30_000;
  switch (input.kind) {
    case "goto": {
      if (!input.target) throw new Error("goto 需要 target=URL");
      await page.goto(input.target, { waitUntil: "domcontentloaded", timeout });
      break;
    }
    case "click": {
      if (!input.target) throw new Error("click 需要 target=选择器");
      await page.click(input.target, { timeout });
      break;
    }
    case "fill": {
      if (!input.target) throw new Error("fill 需要 target=选择器");
      await page.fill(input.target, input.value ?? "", { timeout });
      break;
    }
    case "press": {
      await page.keyboard.press(input.target || input.value || "Enter");
      break;
    }
    case "wait": {
      if (input.target) await page.waitForSelector(input.target, { timeout });
      else await new Promise((r) => setTimeout(r, Math.min(timeout, Number(input.value) || 1000)));
      break;
    }
    case "evaluate": {
      if (!input.target) throw new Error("evaluate 需要 target=JS 表达式或函数体");
      const value = await page.evaluate(input.target);
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        value,
      };
    }
    case "screenshot": {
      const dir = input.shotDir;
      if (!dir) throw new Error("screenshot 需要 shotDir");
      await mkdir(dir, { recursive: true });
      const name = input.shotName || `shot-${Date.now()}.png`;
      const shotPath = join(dir, name);
      await page.screenshot({ path: shotPath, fullPage: false });
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        shotPath,
      };
    }
    default:
      throw new Error(`未知操作：${(input as BrowserActInput).kind}`);
  }
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
  };
}

/** 提取页面可见文本（优先 main/article），供模型理解 */
export async function browserTextSnapshot(page: Page, maxChars = 12_000): Promise<string> {
  const text = await page.evaluate(() => {
    const root =
      document.querySelector("article") || document.querySelector("main") || document.body;
    return (root?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  });
  return text.slice(0, maxChars);
}

/** 尝试读取常见 iframe（如禅道 #appIframe-qa）内文本 */
export async function browserIframeText(
  page: Page,
  selector = "#appIframe-qa, iframe",
  maxChars = 12_000,
): Promise<string | null> {
  try {
    const handle = await page.$(selector);
    if (!handle) return null;
    const frame = await handle.contentFrame();
    if (!frame) return null;
    const text = await frame.evaluate(() => (document.body?.innerText || "").trim());
    return text.slice(0, maxChars);
  } catch {
    return null;
  }
}

export async function writeScreenshotFile(page: Page, dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const shotPath = join(dir, name);
  await page.screenshot({ path: shotPath, fullPage: false });
  return shotPath;
}

/** 便于测试或外部写入元数据 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  describeStep,
  type DeployRecipe,
  type RecipeStep,
  type Server,
  type StepStatus,
} from "@agentdesk/shared";
import type { BrowserSessionManager } from "../browser/session";

export interface RecipeRunCallbacks {
  onStepStart: (index: number) => void;
  onLog: (index: number, message: string) => void;
  onStepEnd: (index: number, status: StepStatus, screenshot: string | null) => void;
  /** 需要人工处理（验证码等）时通知 UI；runner 会以有头模式等待用户完成 */
  onNeedsManual: (reason: string) => void;
  /**
   * 选择器失效时的视觉兜底：传入截图和目标描述，返回点击坐标。
   * 由宿主用多模态模型实现；不提供则直接失败。
   */
  locateByVision?: (screenshot: Buffer, target: string) => Promise<{ x: number; y: number } | null>;
}

export interface RecipeRunOptions {
  recipe: DeployRecipe;
  server: Server;
  password: string;
  browser: BrowserSessionManager;
  screenshotDir: string;
  /** 断点续跑：从该步骤开始，之前的 login 步骤会自动补跑 */
  startAt?: number;
  signal?: AbortSignal;
  callbacks: RecipeRunCallbacks;
  manualLoginTimeoutMs?: number;
}

export interface RecipeRunResult {
  status: "succeeded" | "failed" | "cancelled";
  failedStep: number | null;
  error: string | null;
}

const PROJECT_PAGES: Record<string, string> = {
  node: "/node",
  java: "/java",
  go: "/go",
  python: "/python",
  php: "/site",
};

class RecipeRunner {
  private page!: Page;
  private headless = true;
  private readonly origin: string;

  constructor(private readonly options: RecipeRunOptions) {
    this.origin = new URL(options.server.panelUrl).origin;
  }

  private log(index: number, message: string) {
    this.options.callbacks.onLog(index, message);
  }

  private async open(headless: boolean) {
    this.headless = headless;
    this.page = await this.options.browser.page(this.options.server.id, { headless });
    this.page.setDefaultTimeout(20_000);
  }

  async run(): Promise<RecipeRunResult> {
    const { recipe, startAt = 0, signal, callbacks } = this.options;
    await mkdir(this.options.screenshotDir, { recursive: true });
    await this.open(true);

    if (startAt > 0 && recipe.steps.slice(0, startAt).some((s) => s.type === "login")) {
      await this.login(-1);
    }

    for (let index = startAt; index < recipe.steps.length; index++) {
      if (signal?.aborted) return { status: "cancelled", failedStep: index, error: "已取消" };
      const step = recipe.steps[index]!;
      callbacks.onStepStart(index);
      this.log(index, describeStep(step));
      try {
        await this.execute(step, index);
        callbacks.onStepEnd(index, "succeeded", await this.screenshot(index));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(index, `失败：${message}`);
        callbacks.onStepEnd(index, "failed", await this.screenshot(index));
        return { status: "failed", failedStep: index, error: message };
      }
    }
    return { status: "succeeded", failedStep: null, error: null };
  }

  private async screenshot(index: number): Promise<string | null> {
    if (!this.page || this.page.isClosed()) return null;
    const file = join(this.options.screenshotDir, `step-${String(index).padStart(2, "0")}.png`);
    try {
      await this.page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  }

  private async execute(step: RecipeStep, index: number): Promise<void> {
    switch (step.type) {
      case "login":
        return this.login(index);
      case "open":
        await this.page.goto(new URL(step.path, this.origin).toString(), {
          waitUntil: "domcontentloaded",
        });
        return;
      case "click":
        return this.click(step.selector, step.text, index);
      case "fill":
        await this.page.locator(step.selector).first().fill(step.value);
        return;
      case "waitFor":
        if (step.selector)
          await this.page.locator(step.selector).first().waitFor({ timeout: step.timeoutMs });
        else if (step.text)
          await this.page.getByText(step.text).first().waitFor({ timeout: step.timeoutMs });
        return;
      case "terminal":
        return this.terminal(step.command, step.expect, step.timeoutMs, index);
      case "restartProject":
        return this.restartProject(step.projectType, step.projectName, index);
      case "httpCheck":
        return this.httpCheck(step.url, step.expectStatus, step.retries, index);
      case "sleep":
        await new Promise((r) => setTimeout(r, step.ms));
        return;
      case "screenshot":
        return;
    }
  }

  private async isLoggedIn(): Promise<boolean> {
    if (/\/login/.test(this.page.url())) return false;
    return (await this.page.locator('input[type="password"]:visible').count()) === 0;
  }

  private async login(index: number): Promise<void> {
    const { server, password } = this.options;
    await this.page.goto(server.panelUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    if (await this.isLoggedIn()) {
      this.log(index, "复用已保存的登录态");
      return;
    }

    if (password) {
      const user = this.page
        .locator(
          'input[name="username"], input[autocomplete="username"], input[placeholder*="账号"], input[placeholder*="用户"]',
        )
        .first();
      await user.fill(server.username);
      await this.page.locator('input[type="password"]').first().fill(password);
      await this.page
        .locator('button:has-text("登录"), button[type="submit"], .login-button, #login-button')
        .first()
        .click();
      await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await this.page.waitForTimeout(1500);
      if (await this.isLoggedIn()) {
        this.log(index, "账号密码登录成功");
        return;
      }
    }

    // 需要验证码 / 二次验证 / 未保存密码：切换有头窗口，由用户手动完成登录
    this.options.callbacks.onNeedsManual(
      "需要在弹出的浏览器窗口中手动完成宝塔登录（验证码或二次验证）",
    );
    this.log(index, "等待手动登录…");
    await this.open(false);
    await this.page.goto(server.panelUrl, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + (this.options.manualLoginTimeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      if (this.options.signal?.aborted) throw new Error("已取消");
      await this.page.waitForTimeout(2000);
      if (await this.isLoggedIn()) {
        this.log(index, "手动登录完成");
        return;
      }
    }
    throw new Error("等待手动登录超时");
  }

  private async click(selector: string | undefined, text: string | undefined, index: number) {
    const locator = selector
      ? this.page.locator(selector).first()
      : this.page.getByText(text ?? "", { exact: false }).first();
    try {
      await locator.click({ timeout: 10_000 });
    } catch (error) {
      await this.visionClick(text ?? selector ?? "", index, error);
    }
  }

  private async visionClick(target: string, index: number, original: unknown) {
    const locate = this.options.callbacks.locateByVision;
    if (!locate) throw original;
    this.log(index, `选择器失效，尝试视觉定位「${target}」`);
    const shot = await this.page.screenshot();
    const point = await locate(shot, target);
    if (!point) throw new Error(`视觉定位也未找到「${target}」`);
    await this.page.mouse.click(point.x, point.y);
  }

  /**
   * 通过宝塔网页终端执行命令。追加带退出码的哨兵 echo，
   * 输出里出现 "哨兵+数字" 才算结束（回显的命令行里是 "$?"，不会误判）。
   */
  private async terminal(
    command: string,
    expect: string | undefined,
    timeoutMs: number,
    index: number,
  ) {
    await this.page.goto(`${this.origin}/xterm`, { waitUntil: "domcontentloaded" });
    const term = this.page.locator(".xterm").first();
    await term.waitFor({ timeout: 30_000 });
    await this.page.waitForTimeout(1500);
    await term.click();

    const marker = `__AD_${Date.now().toString(36)}__`;
    await this.page.keyboard.type(`${command}; echo ${marker}$?`, { delay: 5 });
    await this.page.keyboard.press("Enter");

    const pattern = new RegExp(`${marker}(\\d+)`);
    const deadline = Date.now() + timeoutMs;
    let output = "";
    while (Date.now() < deadline) {
      if (this.options.signal?.aborted) throw new Error("已取消");
      await this.page.waitForTimeout(1000);
      output = await this.page
        .locator(".xterm-rows")
        .first()
        .innerText()
        .catch(() => "");
      const match = pattern.exec(output);
      if (match) {
        const tail = output.trim().split("\n").slice(-15).join("\n");
        this.log(index, tail);
        if (match[1] !== "0") throw new Error(`命令退出码 ${match[1]}`);
        if (expect && !output.includes(expect)) throw new Error(`输出中没有找到「${expect}」`);
        return;
      }
    }
    throw new Error(`命令执行超时（${Math.round(timeoutMs / 1000)}s）`);
  }

  private async restartProject(projectType: string, projectName: string, index: number) {
    const path = PROJECT_PAGES[projectType] ?? "/";
    await this.page.goto(`${this.origin}${path}`, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    try {
      const row = this.page.locator("tr", { hasText: projectName }).first();
      await row.waitFor({ timeout: 15_000 });
      await row.getByText("重启", { exact: false }).first().click({ timeout: 10_000 });
    } catch (error) {
      await this.visionClick(`项目「${projectName}」所在行的“重启”按钮`, index, error);
    }
    const confirm = this.page
      .locator('button:has-text("确定"), button:has-text("确认"), .layui-layer-btn0')
      .first();
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
    await this.page.waitForTimeout(3000);
    this.log(index, `已触发重启：${projectName}`);
  }

  private async httpCheck(url: string, expectStatus: number, retries: number, index: number) {
    let last = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        last = `HTTP ${response.status}`;
        if (response.status === expectStatus) {
          this.log(index, `${url} → ${last}`);
          return;
        }
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      this.log(index, `第 ${attempt + 1} 次检查未通过：${last}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`健康检查失败：${last}`);
  }
}

export async function runDeployRecipe(options: RecipeRunOptions): Promise<RecipeRunResult> {
  return new RecipeRunner(options).run();
}

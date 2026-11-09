import { expect, test, type Page } from "@playwright/test";
import { responses } from "../scripts/readme-fixtures";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: false }, version: 0 }),
    );
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ json: responses[path] ?? [] });
  });
}

test("侧栏提示悬停和聚焦后仍能切换页面", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const code = page.getByRole("link", { name: "编码", exact: true });
  await code.hover();
  await expect(page.locator('[data-leibox="fluid-tooltip"][aria-label="编码"]')).toBeVisible();
  await code.click();
  await expect(page.getByRole("heading", { name: "编码", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Bot", exact: true }).click();
  await code.focus();
  await expect(page.locator('[data-leibox="fluid-tooltip"][aria-label="编码"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "编码", exact: true })).toBeVisible();
});

test("侧栏切换不重新挂载离开的页面，连续导航后首页仍可刷新", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/disk/status", (route) =>
    route.fulfill({ json: { ...(responses["/disk/status"] as object), volumes: [] } }),
  );
  await page.route("**/api/disk/scan", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/projects");
  await expect(page.getByRole("heading", { name: "项目中心", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const main = document.querySelector("main")!;
    main.dataset.remountedProjects = "0";
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const headings = [...node.querySelectorAll("h1")];
          if (node.matches("h1")) headings.push(node as HTMLHeadingElement);
          for (const heading of headings) {
            if (heading.textContent === "项目中心") {
              main.dataset.remountedProjects = String(Number(main.dataset.remountedProjects) + 1);
            }
          }
        }
      }
    }).observe(main, { childList: true, subtree: true });
  });
  await page.getByRole("link", { name: "部署", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自动部署", exact: true })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("data-remounted-projects", "0");

  for (const label of ["编码", "热榜", "成长", "工作流", "自动化", "技能", "磁盘", "设置", "Bot"]) {
    const link = page.getByRole("link", { name: label, exact: true });
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  await page.reload();
  await expect(page.getByRole("textbox", { name: "发送消息" })).toBeEditable();
  await page.getByRole("textbox", { name: "发送消息" }).fill("刷新后可以继续输入");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("玻璃选中块跟随不同宽度的选项，窄屏与减少动画保持对齐", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/projects");
  const menu = page
    .locator('[data-leibox="glass-tab-menu"]')
    .filter({ has: page.getByRole("button", { name: "需关注 3", exact: true }) });
  const indicator = menu.locator('[data-leibox="glass-selection"]');
  const aligned = async () => {
    const selected = await menu.locator('[aria-pressed="true"]').boundingBox();
    const surface = await indicator.boundingBox();
    if (!selected || !surface) return Infinity;
    return Math.max(
      Math.abs(selected.x - surface.x),
      Math.abs(selected.y - surface.y),
      Math.abs(selected.width - surface.width),
      Math.abs(selected.height - surface.height),
    );
  };
  for (const name of ["需关注 3", "全部 6"]) {
    await menu.getByRole("button", { name, exact: true }).click();
    await expect.poll(aligned).toBeLessThan(1);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await menu.getByRole("button", { name: "需关注 3", exact: true }).click();
  await expect.poll(aligned).toBeLessThan(1);
  await expect(menu.getByRole("button", { name: "需关注 3", exact: true })).toBeFocused();
});

test("Glass 透镜真实截图渲染，路由切换与减少动画释放渲染器", async ({ page }, info) => {
  await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const lens = page.locator('[data-leibox="glass"]');
  await expect(lens).toHaveAttribute("data-renderer", "webgl");
  const canvas = lens.locator("canvas");
  await lens.getByRole("heading").hover();
  await expect
    .poll(() => canvas.getAttribute("data-capture-count").then(Number))
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-capture-mode", "snapshot");
  await expect(canvas).toHaveAttribute("data-texture-ready", "true");
  const heading = (await lens.getByRole("heading").boundingBox())!;
  const point = {
    x: Math.round(heading.x + heading.width - 80),
    y: Math.round(heading.y + heading.height / 2),
  };
  await page.mouse.move(point.x, point.y);
  await expect(canvas).toHaveAttribute("data-motion-state", "settled");
  // 检查实际截图像素，防止只有 Canvas 挂载成功、玻璃却渲染成黑块。
  const luminance = async () => {
    const pixels = await page.screenshot({ clip: { ...point, width: 4, height: 4 } });
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const probe = document.createElement("canvas");
      probe.width = probe.height = 4;
      const context = probe.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, 4, 4).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4)
        total += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      return total / 16;
    }, pixels.toString("base64"));
  };
  await expect.poll(luminance).toBeGreaterThan(180);
  await page.mouse.move(heading.x + 190, point.y);
  await expect(canvas).toHaveAttribute("data-motion-state", "settled");
  await page.screenshot({ path: info.outputPath("glass-lens.png") });
  await page.getByRole("button", { name: "切换主题" }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  await page.mouse.move(heading.x + 190, point.y + 10);
  await page.mouse.move(heading.x + 190, point.y);
  await expect(canvas).toHaveAttribute("data-motion-state", "settled");
  await page.screenshot({ path: info.outputPath("glass-lens-dark.png") });
  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(lens).toHaveCount(0);
  await page.getByRole("link", { name: "Bot", exact: true }).click();
  await expect(lens).toHaveCount(1);
  await expect(lens).toHaveAttribute("data-renderer", "webgl");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(lens).toHaveAttribute("data-renderer", "static");
  await expect(canvas).toBeHidden();
  await expect(canvas).not.toHaveAttribute("data-capture-count");
  await expect(page.getByRole("textbox", { name: "发送消息" })).toBeEditable();
  expect(errors).toEqual([]);
});

test("无 WebGL 时保留正常界面，原生按压按钮可用键盘操作", async ({ page }, info) => {
  await fixture(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto("/");
  await expect(page.locator('[data-leibox="glass"]')).toHaveAttribute("data-renderer", "static");
  await expect(page.getByRole("heading", { name: /今天想做什么/ })).toBeVisible();
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole("textbox", { name: "发送消息" }).fill("保留正常输入");
  await expect(send).toBeEnabled();
  const theme = page.getByRole("button", { name: "切换主题" }).first();
  await theme.focus();
  await theme.press("Space");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath("glass-home-dark.png") });
  await expect(page.getByRole("textbox", { name: "发送消息" })).toHaveValue("保留正常输入");
});

test("聊天框玻璃文件夹展开选项目，首条消息带 workspace，减少动画仍可选", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: false }, version: 0 }),
    );
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/api/chat")) return original(input, init);
      sessionStorage.setItem("chat-folder-request", String(init?.body ?? ""));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          emit({ type: "conversation", conversationId: "folder-chat" });
          emit({ type: "agent_start", agent: "orchestrator" });
          emit({ type: "text_delta", agent: "orchestrator", delta: "已关联项目。" });
          emit({ type: "done", messageId: "folder-msg" });
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await fixture(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "发送消息" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "关联项目" }).click();
  const folder = page.locator('[data-leibox="glass-folder"]');
  await expect(folder).toBeVisible();
  await expect(folder).toHaveAttribute("data-open", "");
  await folder.getByRole("button", { name: "选择 portal-web" }).click();
  await expect(page.getByRole("button", { name: "关联项目" })).toContainText("portal-web");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "关联项目" }).click();
  await expect(folder).toBeVisible();
  await folder.getByRole("button", { name: "选择 design-system" }).click();
  await expect(page.getByRole("button", { name: "关联项目" })).toContainText("design-system");
  await page.getByRole("button", { name: "关联项目" }).click();
  await expect(page.getByRole("textbox", { name: "本地仓库路径" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入并关联" })).toBeDisabled();
  await page.getByRole("textbox", { name: "本地仓库路径" }).fill("D:/Projects/custom-app");
  await expect(page.getByRole("button", { name: "导入并关联" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "发送消息" }).fill("检查该项目");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("chat-folder-request")))
    .toContain("D:/Projects/design-system");
});

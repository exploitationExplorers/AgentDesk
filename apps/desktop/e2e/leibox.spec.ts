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

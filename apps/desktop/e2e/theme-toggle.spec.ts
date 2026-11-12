import { expect, test } from "@playwright/test";
import { responses } from "../scripts/readme-fixtures";

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    if (!localStorage.getItem("agentdesk-ui")) {
      localStorage.setItem(
        "agentdesk-ui",
        JSON.stringify({ state: { theme: "dark" }, version: 0 }),
      );
    }
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ json: responses[path] ?? [] });
  });
});

test("像素开关连续切换、刷新记忆和键盘操作保持主题一致", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/code");
  const control = page.getByRole("switch", { name: "浅色主题", exact: true });
  await expect(control).toHaveAttribute("aria-checked", "false");
  const canvas = await page.locator(".pixel-effects").elementHandle();
  for (let index = 0; index < 5; index++) {
    await control.click();
    await expect(control).toHaveAttribute("aria-checked", String(index % 2 === 0));
  }
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
  await page.reload();
  await expect(control).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await control.focus();
  await control.press("Space");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await control.press("Enter");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator('[data-motion-component="pixel-toggle"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("拖动可提交或取消，系统主题与设置页双向同步", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#/settings?tab=general");
  const control = page.getByRole("switch", { name: "浅色主题", exact: true });
  await page.getByRole("button", { name: "跟随系统", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(control).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(control).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("html")).toHaveClass(/dark/);
  const box = (await control.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(control).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "浅色", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 12 });
  await control.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(control).toHaveAttribute("aria-checked", "true");
});

test("手机触控、减少动效和无 WebGL 时仍能切换", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  await page.goto("/#/code");
  const control = page.getByRole("switch", { name: "浅色主题", exact: true });
  await expect(control).toBeVisible();
  await expect(page.locator(".pixel-effects")).toBeVisible();
  await control.tap();
  await expect(control).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

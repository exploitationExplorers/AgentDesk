import { expect, test } from "@playwright/test";

test("storage policy persists and cleanup uses a server preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/settings?tab=storage");
  await expect(page.getByRole("heading", { name: "当前设备用量" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /启用每小时自动清理/ })).not.toBeChecked();
  await page.getByLabel("旧截图保留天数").fill("10");
  await page.getByRole("button", { name: "保存存储策略" }).click();
  await expect(page.getByRole("status").filter({ hasText: "存储策略已保存" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("旧截图保留天数")).toHaveValue("10");
  await page.getByRole("button", { name: "预览可清理内容" }).click();
  await expect(page.getByRole("button", { name: "执行本批清理" })).toBeDisabled();
  await expect(page.getByText(/数据库文件不会立即缩小/)).toBeVisible();
  await page.screenshot({ path: "test-results/storage-settings.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

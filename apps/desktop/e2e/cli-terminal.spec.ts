import { expect, test } from "@playwright/test";

test("CLI 终端可交互并在刷新后恢复", async ({ page }) => {
  test.setTimeout(90000);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/#/code?source=cli");
  await expect(page.getByRole("heading", { name: "CLI 终端" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("已连接", { timeout: 30000 });
  const terminal = page.locator(".xterm-helper-textarea");
  await expect(terminal).toBeAttached();
  const screen = page.locator(".xterm-screen");
  await expect(screen).toContainText(/新建对话|输入消息/, { timeout: 30000 });
  await terminal.focus();
  if ((await screen.textContent())?.includes("新建对话")) {
    await page.keyboard.press("Enter");
    await expect(screen).not.toContainText("选择会话", { timeout: 30000 });
  }
  await page.keyboard.type("/help");
  await expect(page.locator(".xterm-screen")).toContainText("/help");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-screen")).toContainText("/resume", { timeout: 30000 });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已连接", { timeout: 30000 });
  await expect(page.locator(".xterm-screen")).toContainText("/resume", { timeout: 30000 });
  expect(failures).toEqual([]);
});

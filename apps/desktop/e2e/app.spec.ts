import { expect, test } from "@playwright/test";

test.describe("AgentDesk", () => {
  test("首页展示 Bot 欢迎区并能在各模块间导航", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /今天想做什么/ })).toBeVisible();
    await expect(page.getByPlaceholder(/问我任何事/)).toBeFocused();
    await expect(page.getByText("还没有配置模型")).toBeVisible();

    for (const [nav, heading] of [
      ["项目", "项目中心"],
      ["部署", "自动部署"],
      ["热榜", "技术热榜"],
      ["工作流", "工作流"],
    ] as const) {
      await page.getByRole("link", { name: nav, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
  });

  test("未配置模型时对话给出明确提示并保存会话", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder(/问我任何事/);
    await composer.fill("你好");
    await composer.press("Enter");
    await expect(page.getByText(/没有可用的模型/)).toBeVisible();
    await expect(page.getByText("你好").first()).toBeVisible();
    await expect(page).toHaveURL(/c=/);
  });

  test("从模板创建工作流、运行并看到实时日志", async ({ page }) => {
    await page.goto("/#/workflows");
    await page.getByRole("button", { name: "新建工作流" }).click();
    await page.getByRole("button", { name: /空白工作流/ }).click();
    await expect(page.getByText("工作流设置")).toBeVisible();

    await page.getByRole("button", { name: "运行", exact: true }).click();
    await expect(page.getByText("运行日志")).toBeVisible();
    await expect(page.getByText("运行成功")).toBeVisible({ timeout: 15_000 });
  });

  test("设置页可以打开导入 Key 对话框，且默认指向 CC Switch", async ({ page }) => {
    await page.goto("/#/settings");
    await page.getByRole("button", { name: /导入/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("CC Switch").first()).toBeVisible();
  });

  test("Ctrl+K 打开命令面板并跳转", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+K");
    const input = page.getByPlaceholder(/搜索/).last();
    await input.fill("热榜");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "技术热榜" })).toBeVisible();
  });
});

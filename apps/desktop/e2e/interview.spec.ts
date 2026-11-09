import { expect, test } from "@playwright/test";

test("面试题批量导入、原答案、练习打卡和失败提示", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: true }, version: 0 }),
    );
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/learning/interview");
  await expect(page.getByRole("heading", { name: "面试题", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "学习设置", exact: true }).click();
  await page.getByRole("spinbutton", { name: "每日目标题数" }).fill("2");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "导入资料", exact: true }).first().click();
  await page.getByLabel("面试资料文件").setInputFiles([
    {
      name: "前端面试.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Q: 什么是闭包？\n答案：原资料的答案：函数与其词法环境的组合。"),
    },
    {
      name: "数据库面试.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "Q: 什么是数据库事务？\n答案：原资料的答案：事务将操作组合为一个工作单元，具有 ACID 特性。",
      ),
    },
  ]);
  await page.getByRole("button", { name: "开始导入" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("已就绪", { exact: true })).toHaveCount(2, { timeout: 20000 });
  await page.getByRole("button", { name: "开始今日练习" }).click();
  await page.getByRole("button", { name: "展开参考答案" }).click();
  await expect(page.locator(".iv-markdown")).toContainText("原资料的答案");
  await expect(page.getByText("资料原答案", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收藏题目", exact: true }).click();
  await page.getByRole("button", { name: "熟练掌握 · 7 天后", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开参考答案" })).toBeVisible();
  await page.getByRole("button", { name: "展开参考答案" }).click();
  await page.getByRole("button", { name: "基本掌握 · 3 天后", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成今日打卡" })).toBeEnabled();
  await page.getByRole("button", { name: "完成今日打卡" }).click();
  await expect(page.getByRole("button", { name: "今日已打卡" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "今日已打卡" })).toBeVisible();
  await page.getByRole("button", { name: "展开参考答案" }).click();
  await page.locator(".iv-page").evaluate((element) => element.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("interview-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "学习统计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "知识领域", exact: true })).toBeVisible();
  await expect(page.getByText("数据库", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("interview-stats.png"), fullPage: true });
  await page.getByRole("button", { name: "导入资料", exact: true }).first().click();
  await page.getByRole("button", { name: "链接", exact: true }).click();
  await page
    .getByRole("textbox", { name: "资料链接", exact: true })
    .fill("https://example.feishu.cn/drive/folder/restricted");
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText("导入失败", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(
    page.locator(".iv-source").filter({ hasText: "example.feishu.cn" }).getByRole("alert"),
  ).toContainText("需要授权");
  const stats = await (
    await request.get("http://127.0.0.1:17950/api/learning/interview/stats")
  ).json();
  expect(stats).toMatchObject({
    total: 2,
    todayReviewed: 2,
    mastered: 1,
    favorites: 1,
    checkedIn: true,
    sourceAnswers: 2,
    aiAnswers: 0,
  });
  await page.getByRole("button", { name: "题库练习", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("heading", { name: "面试题", exact: true })).toBeVisible();
  expect(
    await page
      .locator(".iv-page")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.locator(".iv-page").evaluate((element) => element.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("interview-narrow.png"), fullPage: true });
  expect(errors).toEqual([]);
});

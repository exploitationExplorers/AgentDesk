import { expect, test } from "@playwright/test";

test("跨平台检索明示外部服务，开关持久化且检查结果可见", async ({ page }) => {
  await page.goto("/#/settings?tab=reach");
  await expect(page.getByRole("heading", { name: "让研究助手检索公开内容" })).toBeVisible();
  await expect(page.getByText("Web 搜索会把查询词发送给 Exa。", { exact: false })).toBeVisible();
  await expect(page.getByText("数据发送至：mcp.exa.ai、r.jina.ai")).toBeVisible();
  const disable = page.getByRole("button", { name: "关闭全网渠道" });
  await disable.click();
  await expect(page.getByRole("button", { name: "启用全网渠道" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "启用全网渠道" })).toBeVisible();
  await page.getByRole("button", { name: "启用全网渠道" }).click();
  await expect(disable).toBeVisible();

  // 检查按钮必须发出用户所见的查询；浏览器验证不消耗真实第三方额度。
  await page.route("**/api/reach/run", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      channel: "web",
      action: "search",
      query: "AgentDesk",
      limit: 1,
    });
    await route.fulfill({ json: { ok: true, backend: "exa", items: [] } });
  });
  await page.getByRole("button", { name: "检查连接" }).first().click();
  await expect(page.getByText("连接检查成功", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/reach-settings.png", fullPage: true });
});

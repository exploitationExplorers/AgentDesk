import { expect, test, type Page } from "@playwright/test";
import type { AgentModelBinding, AutomationBinding } from "@agentdesk/shared";
import { responses, feed, workflow, task } from "../scripts/readme-fixtures";

const date = "2026-11-01T08:00:00.000Z";
const automations: AutomationBinding[] = [
  {
    id: "weekly",
    automationId: "weekly",
    hubId: "local",
    ruleName: "weekly",
    title: "每周项目汇报",
    goal: "整理项目进展，输出下一步计划。",
    workspacePolicy: { root: "D:/Projects/portal-web", allowSubdirectories: true },
    enabled: true,
    maxRounds: 20,
    maxMinutes: 30,
    schedule: { cron: "30 9 * * *", timezone: "Asia/Shanghai" },
    createdAt: date,
    updatedAt: date,
  },
  {
    id: "audit",
    automationId: "audit",
    hubId: "local",
    ruleName: "audit",
    title: "发布前质量检查",
    goal: "检查测试结果和待处理事项。",
    workspacePolicy: { root: "D:/Projects/portal-web", allowSubdirectories: true },
    enabled: false,
    maxRounds: 20,
    maxMinutes: 30,
    schedule: null,
    createdAt: date,
    updatedAt: date,
  },
];

async function fixture(page: Page) {
  let bindings: AgentModelBinding[] = [];
  const writes: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem(
      "agentdesk-ui",
      JSON.stringify({ state: { theme: "light", sidebarCollapsed: false }, version: 0 }),
    );
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204 });
    if (!["GET", "HEAD"].includes(method)) writes.push(path);
    if (path === "/agent-bindings") {
      if (method === "PUT") bindings = route.request().postDataJSON() as AgentModelBinding[];
      return route.fulfill({ json: bindings });
    }
    if (path === "/automations") return route.fulfill({ json: automations });
    if (/\/automations\/.+\/tasks$/.test(path))
      return route.fulfill({
        json: [{ ...task, status: "completed", automationStatus: "completed", createdAt: date }],
      });
    if (path === "/autoloop/status")
      return route.fulfill({ json: { available: true, mode: "local", connections: [] } });
    if (path === "/workflows") return route.fulfill({ json: [workflow] });
    if (path === "/feed") return route.fulfill({ json: feed });
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path === "/reach/capabilities" || path === "/reach/status")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: responses[path] ?? [] });
  });
  return {
    get bindings() {
      return bindings;
    },
    writes,
  };
}

test("项目筛选与搜索可组合，键盘可打开详情并重置空结果", async ({ page }, info) => {
  await fixture(page);
  await page.goto("/#/projects");
  await expect(page.getByRole("button", { name: /^查看项目 / })).toHaveCount(6);
  await page.screenshot({ path: info.outputPath("projects-light.png") });
  await page.getByRole("button", { name: "需关注 3", exact: true }).click();
  await expect(page.getByRole("button", { name: /^查看项目 / })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "需关注 3", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("textbox", { name: "搜索项目" }).fill("portal");
  const project = page.getByRole("button", { name: "查看项目 portal-web", exact: true });
  await expect(page.getByRole("button", { name: /^查看项目 / })).toHaveCount(1);
  await project.focus();
  await project.press("Enter");
  await expect(page.getByRole("dialog", { name: "portal-web" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索项目" }).fill("no-such-project");
  await expect(page.getByText("没有匹配的项目", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选" }).click();
  await expect(page.getByRole("button", { name: /^查看项目 / })).toHaveCount(6);
});

test("设置分类保留路由、键盘与模型绑定保存，窄屏字段可用", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/#/settings");
  const providers = page.getByRole("tab", { name: "模型 Provider", exact: true });
  const bindings = page.getByRole("tab", { name: "Agent 模型", exact: true });
  await expect(providers).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: info.outputPath("settings-light.png") });
  await providers.focus();
  await providers.press("ArrowDown");
  await expect(bindings).toBeFocused();
  await bindings.press("Enter");
  await expect(page).toHaveURL(/tab=bindings/);
  await page
    .getByRole("combobox", { name: "AgentDesk Provider", exact: true })
    .selectOption("demo-provider");
  await page.getByRole("combobox", { name: "AgentDesk模型", exact: true }).fill("gpt-5.2");
  await page.getByRole("button", { name: "保存绑定" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(state.bindings).toEqual([
    {
      agent: "orchestrator",
      providerId: "demo-provider",
      model: "gpt-5.2",
      fallbackProviderIds: [],
    },
  ]);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "AgentDesk模型", exact: true })).toHaveValue(
    "gpt-5.2",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tablist", { name: "设置分类" })).toHaveAttribute(
    "aria-orientation",
    "horizontal",
  );
  await page.screenshot({ path: info.outputPath("settings-bindings-mobile.png") });
  for (const name of ["通用", "Git 平台", "记忆", "模型 Provider"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.locator(".ad-page").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
  await page.getByRole("switch", { name: "浅色主题" }).first().click();
  await page.screenshot({ path: info.outputPath("settings-mobile-dark.png") });
});

test("自动化筛选与运行记录展开不触发执行，停用项仍保留成果入口", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/#/automations");
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("automations-light.png") });
  await page.getByRole("button", { name: "已停用", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "立即运行" })).toBeDisabled();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByRole("link", { name: "查看会话与成果" })).toBeVisible();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByRole("link", { name: "查看会话与成果" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索自动化" }).fill("每周");
  await expect(page.getByText("没有匹配的自动化", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
  expect(state.writes).toEqual([]);
});

test("管理页面在明暗主题与窄屏下无横向溢出", async ({ page }, info) => {
  test.setTimeout(60_000);
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [path, title] of [
    ["projects", "项目中心"],
    ["automations", "自动化"],
    ["deploy", "自动部署"],
    ["feed", "技术热榜"],
    ["workflows", "工作流"],
    ["skills", "技能"],
  ]) {
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.goto(`/#/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    if (await page.locator("html").evaluate((el) => el.classList.contains("dark"))) {
      await page.getByRole("switch", { name: "浅色主题" }).first().click();
    }
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.screenshot({ path: info.outputPath(`${path}-light.png`) });
    await page.getByRole("switch", { name: "浅色主题" }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: info.outputPath(`${path}-dark.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath(`${path}-mobile.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const overflow = await page.locator(".ad-page").evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
      elements: [...el.querySelectorAll("*")]
        .filter(
          (child) =>
            child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 &&
            !child.closest(".ad-segmented"),
        )
        .slice(0, 5)
        .map((child) => child.className),
    }));
    expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
  }
});

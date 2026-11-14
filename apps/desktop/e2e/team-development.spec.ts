import { expect, test } from "@playwright/test";
import type { TeamClaim, TeamSession } from "@agentdesk/shared";

test("两位真实成员邀请入群、Agent 配对、分工开发、群聊、进度与验收", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/team");
  await page.getByRole("button", { name: "创建项目群", exact: true }).click();
  const create = page.getByRole("dialog", { name: "创建团队项目" });
  await create.getByLabel("项目名称", { exact: true }).fill("IM 团队项目");
  await create.getByLabel("你的名字").fill("项目负责人");
  await create.getByLabel("项目目标").fill("分工开发聊天系统，最后汇总回归");
  await create.getByLabel("共享仓库地址").fill("https://github.com/team/im.git");
  await create.getByLabel("起始提交 SHA").fill("a".repeat(40));
  await create.getByRole("button", { name: "创建项目群", exact: true }).click();
  await expect(create).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "IM 团队项目", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  const invite = page.getByRole("dialog", { name: "邀请团队成员" });
  const link = await invite.getByLabel("项目邀请链接").inputValue();
  await invite.getByRole("button", { name: "关闭", exact: true }).click();
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const friend = await context.newPage();
  friend.on("pageerror", (error) => errors.push(error.message));
  try {
    await friend.goto(link);
    const join = friend.getByRole("dialog", { name: "加入团队项目" });
    await join.getByLabel("你的名字").fill("朋友的 Codex");
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(join).not.toBeVisible();
    await friend.getByRole("button", { name: "连接我的 Agent", exact: true }).click();
    const pairing = friend.getByRole("dialog", { name: "连接我的 Agent" });
    const code = await pairing.getByLabel("Agent 配对码").inputValue();
    const response = await request.post("http://127.0.0.1:17950/team-api/v1/pair", {
      data: { code, name: "Codex 本机连接" },
    });
    expect(response.ok()).toBe(true);
    const agent = (await response.json()) as TeamSession;
    const headers = { Authorization: `Bearer ${agent.token}` };
    await pairing.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "任务与进度", exact: true }).click();
    await page.getByRole("button", { name: "分配任务", exact: true }).click();
    const task = page.getByRole("dialog", { name: "分配开发任务" });
    await task.getByLabel("任务名称").fill("开发 IM 账号模块");
    await expect(
      task.getByLabel("分配给").locator("option").filter({ hasText: "朋友的 Codex" }),
    ).toHaveCount(1);
    await task.getByLabel("分配给").selectOption(agent.member.id);
    await task.getByLabel("开发要求与范围").fill("负责账号注册和登录，保持消息接口契约不变。");
    await task.getByLabel("验收标准（每行一项）").fill("登录接口单测通过\n未授权请求被拒绝");
    await task.getByRole("button", { name: "分配任务", exact: true }).click();
    await expect(task).not.toBeVisible();
    const claimResponse = await request.post("http://127.0.0.1:17950/team-api/v1/claim", {
      headers,
      data: {},
    });
    const claim = (await claimResponse.json()) as TeamClaim;
    expect(claim.task.title).toBe("开发 IM 账号模块");
    await request.post(`http://127.0.0.1:17950/team-api/v1/tasks/${claim.task.id}/progress`, {
      headers,
      data: { lease: claim.lease, progress: "正在开发登录接口并补充测试" },
    });
    await expect(page.getByTestId("team-task")).toContainText("正在开发登录接口并补充测试");
    await friend.getByLabel("发送到项目群").fill("请确认登录接口使用统一错误码。");
    await friend.getByRole("button", { name: "发送群消息" }).click();
    await page.getByRole("button", { name: "群聊讨论", exact: true }).click();
    await expect(page.getByText("请确认登录接口使用统一错误码。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "引用", exact: true }).last().click();
    await page.getByLabel("发送到项目群").fill("确认，沿用项目错误码契约。");
    await page.getByRole("button", { name: "发送群消息" }).click();
    await expect(friend.getByText("确认，沿用项目错误码契约。", { exact: true })).toBeVisible();
    await request.post(`http://127.0.0.1:17950/team-api/v1/tasks/${claim.task.id}/submit`, {
      headers,
      data: {
        lease: claim.lease,
        delivery: {
          revision: "b".repeat(40),
          summary: "登录功能已交付，含未授权测试",
          checks: [{ name: "账号模块单测", exitCode: 0 }],
        },
      },
    });
    await page.getByRole("button", { name: "任务与进度", exact: true }).click();
    const card = page.getByTestId("team-task");
    await expect(card).toContainText("登录功能已交付");
    await card
      .getByLabel("处理意见：开发 IM 账号模块")
      .fill("已检查接口和测试，功能验收通过，等待整体集成。");
    await card.getByRole("button", { name: "验收通过", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("已验收");
    await page.screenshot({ path: testInfo.outputPath("team-delivery.png") });
    await page.reload();
    await expect(page.getByRole("heading", { name: "IM 团队项目", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "任务与进度", exact: true }).click();
    await expect(page.getByTestId("team-task")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("team-mobile.png") });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

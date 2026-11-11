import { expect, test } from "@playwright/test";

test("空库可以直接添加记忆，刷新后仍保留，并能更正与删除", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/settings?tab=memory");
  await expect(page.getByText("这里还没有记忆", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /启用长期记忆/ })).toBeChecked();

  await page.getByRole("button", { name: "添加记忆", exact: true }).click();
  await page
    .getByRole("textbox", { name: "记忆内容", exact: true })
    .fill("用户偏好先展示实际验证结果");
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByText("用户偏好先展示实际验证结果", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("用户偏好先展示实际验证结果", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "更正", exact: true }).click();
  await page.getByRole("textbox", { name: "更正记忆内容" }).fill("用户偏好同时说明验证限制");
  await page.getByRole("button", { name: "保存更正", exact: true }).click();
  await expect(page.getByText("用户偏好同时说明验证限制", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "全部记录", exact: true }).click();
  await expect(page.getByText("已被更正", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "已生效", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("用户偏好同时说明验证限制", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("这里还没有记忆", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "全部记录", exact: true }).click();
  await expect(page.getByText("这里还没有记忆", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("真实记忆回归生成逐案例结果，Agent 评测要求显式模型选择", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/settings?tab=evolution");
  await page.getByRole("button", { name: "提出改进", exact: true }).click();
  await page.getByRole("textbox", { name: "候选标题" }).fill("检查实际返回结果");
  await page
    .getByRole("textbox", { name: "候选指导" })
    .fill("报告完成前检查工具返回值并说明实际验证结果。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await page.getByRole("button", { name: "Agent 沙箱评测…", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "允许本次评测调用模型并产生费用。", exact: true })
    .check();
  await expect(page.getByRole("combobox", { name: "评测模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认开始评测", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "本地记忆回归", exact: true }).click();
  await expect(page.getByText(/36\/36 个案例/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "审核发布…", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

// 以下仅注入接口兼容/故障响应；真实写入与评测由上面两个无路由 mock 的测试覆盖。
test("评测请求包含用户所选模型，未确认前不发起模型评测", async ({ page }) => {
  const providerId = "synthetic-provider";
  const model = "synthetic-model";
  const requests: unknown[] = [];
  await page.route("**/api/providers", (route) =>
    route.fulfill({
      json: [{ id: providerId, name: "本地测试模型", models: [model], enabled: true }],
    }),
  );
  await page.route("**/api/evolution/proposals/*/evaluate", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: { code: "CONFLICT", message: "已验证模型参数，没有调用供应商。" } },
    });
  });
  await page.goto("/#/settings?tab=evolution");
  await page.getByRole("button", { name: "提出改进", exact: true }).click();
  await page.getByRole("textbox", { name: "候选标题" }).fill("模型参数绑定验证");
  await page.getByRole("textbox", { name: "候选指导" }).fill("先验证实际结果再报告完成。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型参数绑定验证", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Agent 沙箱评测…", exact: true }).first().click();
  await page
    .getByRole("combobox", { name: "评测模型" })
    .selectOption(JSON.stringify([providerId, model]));
  await expect(page.getByRole("button", { name: "确认开始评测", exact: true })).toBeDisabled();
  expect(requests).toEqual([]);
  await page
    .getByRole("checkbox", { name: "允许本次评测调用模型并产生费用。", exact: true })
    .check();
  await page.getByRole("button", { name: "确认开始评测", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已验证模型参数");
  expect(requests).toEqual([
    { mode: "agent", allowModelCalls: true, modelSelection: { providerId, model } },
  ]);
});

test("旧记录缺少治理字段时使用共享契约默认值，不把记录隐藏", async ({ page }) => {
  await page.route("**/api/memories", (route) =>
    route.fulfill({
      json: [
        {
          id: "legacy-memory",
          namespace: "user",
          kind: "preference",
          text: "旧版记录仍可管理",
          source: "tool",
          conversationId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await page.goto("/#/settings?tab=memory");
  await expect(page.getByText("旧版记录仍可管理", { exact: true })).toBeVisible();
});

test("记忆接口返回错误结构时展示错误与重试，保留设置页面", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/memories", (route) => route.fulfill({ json: { unexpected: [] } }));
  await page.goto("/#/settings?tab=memory");
  await expect(page.getByText(/加载失败：/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "记忆与提取", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

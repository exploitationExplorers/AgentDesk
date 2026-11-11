import { expect, test, type Page } from "@playwright/test";

const session = {
  user: { id: "owner-1", email: "owner@example.com", role: "owner" },
  session: {
    id: "session-1",
    expiresAt: "2026-11-15T12:00:00.000Z",
    recentAuthAt: "2026-11-08T12:00:00.000Z",
  },
  csrfToken: "test-csrf-token",
};
const task = {
  id: "task-1",
  title: "修复仓库中的登录回归",
  goal: "调查登录状态为何没有正确刷新，并补上测试。",
  agent: "code",
  conversationId: "conversation-1",
  requiresPlanApproval: true,
  status: "running",
  currentRunId: "run-1",
  pendingApprovalId: null,
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:03:00.000Z",
  closedAt: null,
};

async function mockGateway(page: Page, authenticated = false) {
  let signedIn = authenticated;
  let otpRequested = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "Cache-Control": "no-store" },
      });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "login-csrf" });
    if (path === "/api/v1/auth/otp/request" && method === "POST") {
      otpRequested = true;
      return json({ message: "如果邮箱有效，你将收到验证码。" }, 202);
    }
    if (path === "/api/v1/auth/otp/verify" && method === "POST") {
      signedIn = otpRequested;
      return json({ authenticated: signedIn }, signedIn ? 200 : 401);
    }
    if (path === "/api/v1/session" && method === "GET")
      return signedIn
        ? json(session)
        : json({ error: { code: "UNAUTHORIZED", message: "请登录" } }, 401);
    if (!signedIn) return json({ error: { code: "UNAUTHORIZED", message: "请登录" } }, 401);
    if (path === "/api/v1/hosts")
      return json({
        hosts: [
          {
            id: "cloud",
            name: "云端执行器",
            kind: "cloud",
            status: "online",
            lastSeen: "2026-11-08T09:03:00.000Z",
            capabilities: ["task.create", "git.preview"],
          },
        ],
      });
    if (path === "/api/v1/hosts/cloud/projects")
      return json({
        projects: [
          { id: "project-1", name: "agentdesk", workspaceId: "workspace-1", branch: "main" },
        ],
      });
    if (path === "/api/v1/hosts/cloud/tasks/task-1")
      return json({
        task,
        runs: [
          {
            id: "run-1",
            taskId: task.id,
            parentRunId: null,
            kind: "root",
            agent: "code",
            status: "running",
            trigger: "create",
            idempotencyKey: null,
            input: { userMessage: task.goal },
            resultText: null,
            resultError: null,
            toolCalls: null,
            cancelRequested: false,
            cancelRequestedAt: null,
            startedAt: "2026-11-08T09:01:00.000Z",
            endedAt: null,
            createdAt: task.createdAt,
          },
        ],
      });
    if (path === "/api/v1/hosts/cloud/tasks") return json({ tasks: [task] });
    if (path === "/api/v1/approvals") return json({ approvals: [] });
    if (path === "/api/v1/hosts/cloud/providers") return json({ providers: [] });
    if (path === "/api/v1/hosts/cloud/executors")
      return json({ executors: [{ id: "native-bot", available: true }] });
    return json({ error: { code: "NOT_FOUND", message: "mock route missing" } }, 404);
  });
}

test("邮箱 OTP 登录后在 360/390/430 px 管理项目与任务，无横向溢出", async ({ page }) => {
  await mockGateway(page);
  await page.goto("/cloud.html");
  await expect(page.getByRole("heading", { name: /从手机接上\s*你的工作现场。/ })).toBeVisible();
  await page.getByLabel("邮箱地址").fill("owner@example.com");
  await page.getByRole("button", { name: "发送登录验证码" }).click();
  await expect(page.getByText(/验证码将发送至收件箱/)).toBeVisible();
  const otp = page.getByLabel("6 位验证码").or(page.getByRole("textbox").first());
  if (await page.getByRole("button", { name: "输入验证码" }).count()) {
    await page.getByRole("button", { name: "输入验证码" }).click();
  }
  await otp.fill("123456");
  const verify = page.getByRole("button", { name: "验证并登录" });
  if (await verify.count()) await verify.click();
  await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible();
  await expect(page.getByRole("button", { name: /agentdesk/ })).toBeVisible();

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      )
      .toBe(true);
    await expect(page.getByRole("strong").filter({ hasText: "云端执行器" })).toBeVisible();
    for (const label of ["工作区", "任务", "审批", "设置"]) {
      const bounds = await page.getByRole("tab", { name: label, exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `test-results/cloud-${width}.png`, fullPage: true });
  }

  await page.getByRole("button", { name: /agentdesk/ }).click();
  await expect(page.getByRole("heading", { name: "项目任务" })).toBeVisible();
  await page.getByRole("button", { name: /修复仓库中的登录回归/ }).click();
  await expect(page.getByText(/调查登录状态为何没有正确刷新/)).toBeVisible();
  await page.getByRole("button", { name: "刷新任务" }).click();
  await expect(page.getByRole("heading", { name: task.title })).toBeVisible();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建任务" }).first().click();
  await expect(page.getByRole("heading", { name: "给项目一个目标。" })).toBeVisible();
  await expect(page.getByLabel("你想完成什么？")).toBeVisible();
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作区", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "工作区", exact: true }).press("ArrowRight");
  await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/cloud-navigation.png", fullPage: true });
});

test("提交任务后保留详情，离线审批不发送，恢复后提交绑定的审批", async ({ page, context }) => {
  await mockGateway(page, true);
  let submissions = 0;
  let decisions = 0;
  const approval = {
    approval: {
      id: "approval-1",
      title: "写入测试文件",
      detail: "创建 result.txt",
      risk: "confirm",
      payload: { path: "result.txt" },
      status: "pending",
    },
    context: {
      hostId: "cloud",
      projectId: "project-1",
      workspaceId: "workspace-1",
      version: 1,
      actionDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  };
  await page.route("**/api/v1/approvals", (route) =>
    route.fulfill({ json: { approvals: submissions && !decisions ? [approval] : [] } }),
  );
  await page.route("**/api/v1/hosts/cloud/projects/project-1/tasks", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      goal: "检查测试文件",
      executor: "native-bot",
      workspaceId: "workspace-1",
      requiresPlanApproval: true,
      clientRequestId: expect.any(String),
    });
    expect(route.request().headers()["x-csrf-token"]).toBe(session.csrfToken);
    submissions++;
    await route.fulfill({ status: 202, json: { task } });
  });
  await page.route("**/api/v1/hosts/cloud/approvals/approval-1/resolve", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      approved: true,
      version: 1,
      actionDigest: approval.context.actionDigest,
      clientRequestId: expect.any(String),
    });
    decisions++;
    await route.fulfill({ json: { resolved: true } });
  });
  await page.goto("/cloud.html");
  await page.getByRole("button", { name: "新建任务" }).first().click();
  await page.getByLabel("你想完成什么？").fill("检查测试文件");
  await page.getByRole("button", { name: "提交任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: task.title })).toBeVisible();
  expect(submissions).toBe(1);
  await page.getByRole("tab", { name: "审批", exact: true }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "写入测试文件" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "批准并继续" })).toBeDisabled();
  expect(decisions).toBe(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "批准并继续" }).click();
  await expect(page.getByRole("heading", { name: "当前没有待审批操作" })).toBeVisible();
  expect(decisions).toBe(1);
});

test("选择文件审阅后提交，推送需要另一次预览与审批", async ({ page }) => {
  await mockGateway(page, true);
  const requests: string[] = [];
  let committed = false;
  let currentKind = "commit";
  const base = "/api/v1/hosts/cloud/projects/project-1/git";
  await page.route("**/api/v1/hosts/cloud/projects/project-1/git/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          head: "b".repeat(40),
          branch: "refs/heads/main",
          files: committed
            ? []
            : [
                {
                  path: "README.md",
                  previousPath: null,
                  kind: "modified",
                  indexStatus: " ",
                  worktreeStatus: "M",
                },
              ],
        },
      });
    const body = route.request().postDataJSON();
    if (path.endsWith("/preview")) {
      currentKind = body.kind;
      requests.push(`preview:${currentKind}`);
      if (currentKind === "commit")
        expect(body).toMatchObject({ files: ["README.md"], message: "fix: mobile change" });
      else expect(body).toMatchObject({ remote: "origin", ref: "refs/heads/main" });
      return route.fulfill({
        json: {
          operation: {
            result: {
              previewId: `preview-${currentKind}`,
              approvalId: `approval-${currentKind}`,
              version: 1,
              actionDigest: "c".repeat(64),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              files: ["README.md"],
              diff: "+reviewed content",
              commits: [{ sha: "b".repeat(40), subject: "fix: mobile change" }],
            },
          },
        },
      });
    }
    expect(path).toBe(`${base}/${currentKind}`);
    expect(body).toMatchObject({
      previewId: `preview-${currentKind}`,
      approvalId: `approval-${currentKind}`,
      actionDigest: "c".repeat(64),
      version: 1,
    });
    requests.push(currentKind);
    committed = true;
    return route.fulfill({
      json: { operation: { status: "succeeded", result: { sha: "b".repeat(40) } } },
    });
  });
  await page.route("**/api/v1/hosts/cloud/approvals/*/resolve", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      approved: true,
      version: 1,
      actionDigest: "c".repeat(64),
    });
    requests.push(`approve:${currentKind}`);
    await route.fulfill({ json: { resolved: true } });
  });
  await page.goto("/cloud.html");
  await page.getByRole("button", { name: /agentdesk main/ }).click();
  await page.getByRole("button", { name: /Git 操作/ }).click();
  await page.getByRole("checkbox", { name: /README.md/ }).check();
  await page.getByLabel("提交说明").fill("fix: mobile change");
  await page.getByRole("button", { name: /生成 Git 预览/ }).click();
  await expect(page.getByText("+reviewed content")).toBeVisible();
  expect(requests).toEqual(["preview:commit"]);
  await page.getByRole("button", { name: "批准并提交", exact: true }).click();
  await expect(page.getByText("Git 执行结果")).toBeVisible();
  expect(requests).toEqual(["preview:commit", "approve:commit", "commit"]);
  await page.getByRole("button", { name: "预览推送", exact: true }).click();
  await expect(page.getByText("fix: mobile change", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "批准并推送", exact: true }).click();
  await expect
    .poll(() => requests)
    .toEqual([
      "preview:commit",
      "approve:commit",
      "commit",
      "preview:push",
      "approve:push",
      "push",
    ]);
});

test("API 与任务数据不加入 Service Worker 公共缓存名单", async ({ request }) => {
  const response = await request.get("/cloud-sw.js");
  expect(response.ok()).toBe(true);
  const source = await response.text();
  expect(source).toContain("PUBLIC_PATHS");
  expect(source).toContain("/api/");
  expect(source).toContain('event.request.method !== "GET"');
  expect(source).toContain("url.search");
});

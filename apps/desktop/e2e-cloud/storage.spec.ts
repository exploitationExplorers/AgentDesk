import { expect, test, type Page, type Route } from "@playwright/test";

async function mockStorage(
  page: Page,
  options: { role?: string; capability?: boolean; hostId?: string } = {},
) {
  const state = {
    writes: [] as Array<{
      path: string;
      method: string;
      body: Record<string, unknown>;
      csrf?: string;
    }>,
    reads: [] as string[],
    unexpected: [] as string[],
    policy: {
      automaticCleanup: false,
      screenshotDays: 3,
      traceDays: 7,
      eventDays: 30,
      cacheLimitMiB: 2048,
      reserveGiB: 5,
      reservePercent: 5,
    },
    failCleanup: false,
    ttl: 300_000,
    releasePreview: null as (() => void) | null,
    delayPreview: false,
  };
  const json = (route: Route, value: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = method === "GET" ? {} : (req.postDataJSON() as Record<string, unknown>);
    if (method === "GET") state.reads.push(path);
    else state.writes.push({ path, method, body, csrf: req.headers()["x-csrf-token"] });
    if (path === "/api/v1/session")
      return json(route, {
        user: { id: "owner-1", email: "owner@example.test", role: options.role ?? "owner" },
        session: {
          id: "session-1",
          expiresAt: "2099-01-01T00:00:00Z",
          recentAuthAt: new Date().toISOString(),
        },
        csrfToken: "storage-csrf",
      });
    if (path === "/api/v1/hosts")
      return json(route, {
        hosts: ["cloud", "office"].map((id) => ({
          id,
          name: `${id} host`,
          kind: id,
          status: "online",
          capabilities: options.capability === false ? [] : ["storage.manage"],
        })),
      });
    if (path === "/api/v1/approvals") return json(route, { approvals: [] });
    if (/\/hosts\/(cloud|office)\/(projects|tasks|providers|executors)$/.test(path))
      return json(route, { projects: [], tasks: [], providers: [], bindings: [], executors: [] });
    if (path === "/api/v1/hosts/cloud/storage" && method === "GET")
      return json(route, {
        hostId: options.hostId ?? "cloud",
        policy: state.policy,
        usage: {
          measuredAt: new Date().toISOString(),
          dataDir: "/srv/agentdesk/very-long-directory-name/data",
          totalBytes: 1024 ** 3,
          incomplete: false,
          disk: {
            totalBytes: 100 * 1024 ** 3,
            freeBytes: 20 * 1024 ** 3,
            reserveBytes: 5 * 1024 ** 3,
          },
          warnings: [],
          items: [
            {
              name: "browser-shots",
              bytes: 1024 ** 3,
              files: 2,
              incomplete: false,
              protected: false,
            },
          ],
        },
      });
    if (path === "/api/v1/hosts/cloud/storage/policy" && method === "PUT") {
      state.policy = body as typeof state.policy;
      return json(route, state.policy);
    }
    if (path === "/api/v1/hosts/cloud/storage/cleanup/preview") {
      if (state.delayPreview)
        await new Promise<void>((resolve) => {
          state.releasePreview = resolve;
        });
      return json(route, {
        id: "7c027c09-ed9f-401d-963b-f61a3bbf3001",
        expiresAt: new Date(Date.now() + state.ttl).toISOString(),
        files: 2,
        fileBytes: 1024,
        events: 20,
        traces: 3,
        warnings: [],
      });
    }
    if (path === "/api/v1/hosts/cloud/storage/cleanup")
      return state.failCleanup
        ? json(
            route,
            { error: { code: "UNAVAILABLE", message: "清理响应不可用，请重新预览" } },
            503,
          )
        : json(route, {
            files: 2,
            fileBytes: 1024,
            events: 20,
            traces: 3,
            skipped: 0,
            completedAt: new Date().toISOString(),
          });
    state.unexpected.push(`${method} ${path}`);
    return json(route, { error: { code: "NOT_FOUND", message: path } }, 404);
  });
  return state;
}

async function openStorage(page: Page) {
  await page.goto("/cloud.html");
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /云宿主存储/ }).click();
  await expect(page.getByRole("button", { name: "保存云宿主策略" })).toBeEnabled();
}

test("cloud storage saves policy and requires a fresh single-use cleanup preview", async ({
  page,
}) => {
  const state = await mockStorage(page);
  await openStorage(page);
  await page.getByLabel("旧截图保留天数").fill("10");
  await expect(page.getByRole("button", { name: "预览云宿主清理" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "启用每小时自动清理" }).check();
  await page.getByRole("button", { name: "保存云宿主策略" }).click();
  await expect(page.getByText("云宿主存储策略已保存。")).toBeVisible();
  await expect(page.getByRole("button", { name: "预览云宿主清理" })).toBeEnabled();
  await page.getByRole("button", { name: "预览云宿主清理" }).click();
  await expect(page.getByRole("button", { name: "执行云宿主本批清理" })).toBeVisible();
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/cloud-storage-preview.png", fullPage: true });
  await page.getByRole("button", { name: "执行云宿主本批清理" }).click();
  await expect(page.getByText(/已删除 2 个文件/)).toBeVisible();
  await expect(page.getByRole("button", { name: "执行云宿主本批清理" })).toHaveCount(0);
  expect(state.writes.map((write) => write.method)).toEqual(["PUT", "POST", "POST"]);
  expect(state.writes[0]?.body).toMatchObject({ screenshotDays: 10, automaticCleanup: true });
  expect(state.writes[2]?.body).toEqual({ previewId: "7c027c09-ed9f-401d-963b-f61a3bbf3001" });
  expect(state.writes.every((write) => write.csrf === "storage-csrf")).toBe(true);
  await page.reload();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /云宿主存储/ }).click();
  await expect(page.getByLabel("旧截图保留天数")).toHaveValue("10");
  expect(state.unexpected).toEqual([]);
});

for (const scenario of ["member", "legacy", "office"] as const) {
  test(`${scenario} does not expose host storage management`, async ({ page }) => {
    const state = await mockStorage(page, {
      role: scenario === "member" ? "member" : "owner",
      capability: scenario !== "legacy",
    });
    await page.goto("/cloud.html");
    if (scenario === "office")
      await page.getByRole("combobox", { name: "当前执行宿主" }).selectOption("office");
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await expect(page.getByRole("button", { name: /云宿主存储/ })).toHaveCount(0);
    expect(state.reads.filter((path) => path.includes("/storage"))).toEqual([]);
  });
}

test("offline and mismatched hosts cannot write storage policy", async ({ page }) => {
  const state = await mockStorage(page, { hostId: "office" });
  await page.goto("/cloud.html");
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /云宿主存储/ }).click();
  await expect(page.getByText("宿主响应不匹配，请刷新后重试。")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存云宿主策略" })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test("failed cleanup cannot be retried without another preview and offline writes stay disabled", async ({
  page,
  context,
}) => {
  const state = await mockStorage(page);
  state.failCleanup = true;
  await openStorage(page);
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "保存云宿主策略" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "预览云宿主清理" })).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole("button", { name: "预览云宿主清理" }).click();
  await page.getByRole("button", { name: "执行云宿主本批清理" }).click();
  await expect(page.getByText("清理响应不可用，请重新预览")).toBeVisible();
  await expect(page.getByRole("button", { name: "执行云宿主本批清理" })).toHaveCount(0);
  expect(state.writes.filter((write) => write.path.endsWith("/cleanup"))).toHaveLength(1);
});

test("expired cleanup preview is removed and a delayed preview is discarded after leaving the host", async ({
  page,
}) => {
  const state = await mockStorage(page);
  state.ttl = 500;
  await openStorage(page);
  await page.getByRole("button", { name: "预览云宿主清理" }).click();
  await expect(page.getByText("清理预览已过期，请重新预览。")).toBeVisible();
  await expect(page.getByRole("button", { name: "执行云宿主本批清理" })).toHaveCount(0);
  state.ttl = 300_000;
  state.delayPreview = true;
  await page.getByRole("button", { name: "预览云宿主清理" }).click();
  await expect.poll(() => Boolean(state.releasePreview)).toBe(true);
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  await page.getByRole("combobox", { name: "当前执行宿主" }).selectOption("office");
  state.releasePreview!();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button", { name: /云宿主存储/ })).toHaveCount(0);
  expect(state.writes.filter((write) => write.path.endsWith("/cleanup"))).toEqual([]);
});

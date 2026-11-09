import { expect, test, type Page } from "@playwright/test";

async function gateway(page: Page) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let paired = false,
    revoked = false,
    transferState = "paused",
    codexReady = false;
  let imported = false;
  const device = {
    id: "office",
    state: "pending",
    fingerprint: "a".repeat(64),
    projects: [] as string[],
    identity: {
      name: "Office PC",
      platform: "win32",
      instanceId: "office-instance",
      publicKey: "test",
      projects: [
        { id: "office-project", name: "IM", path: "D:/work/IM" },
        { id: "private-project", name: "Private", path: "D:/private" },
      ],
    },
  };
  const transfer = {
    id: "transfer-1",
    bytes: 12,
    manifestDigest: "c".repeat(64),
    manifest: {
      version: 1,
      snapshotId: "snapshot-1",
      sourceHead: "b".repeat(40),
      entries: [{ path: "code.txt", kind: "file", size: 12 }],
      exclusions: [{ path: ".env", reason: "credential" }],
    },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    const body = method === "GET" ? {} : route.request().postDataJSON();
    if (method !== "GET") {
      expect(route.request().headers()["x-csrf-token"]).toBe("csrf");
      writes.push({ path, body });
    }
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path.endsWith("/session"))
      return json({
        user: { id: "owner", email: "owner@example.test", role: "owner" },
        session: { id: "session", expiresAt: "2099-01-01T00:00:00Z" },
        csrfToken: "csrf",
      });
    if (path.endsWith("/hosts"))
      return json({
        hosts: [
          { id: "cloud", kind: "cloud", name: "Cloud", status: "online", capabilities: [] },
          ...(!revoked
            ? [
                {
                  id: "office",
                  kind: "office",
                  name: "Office PC",
                  status: "online",
                  capabilities: [],
                },
              ]
            : []),
        ],
      });
    if (path.endsWith("/approvals")) return json({ approvals: [] });
    if (path.endsWith("/executors"))
      return json({
        executors: [
          { id: "native-bot", available: true },
          {
            id: "codex",
            available: codexReady,
            reason: codexReady ? undefined : "请在此宿主完成 Codex 登录",
          },
        ],
      });
    if (path.endsWith("/codex/login"))
      return json({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "TEST-DEVICE",
      });
    if (path.endsWith("/codex/login-status")) {
      codexReady = true;
      return json({ id: "codex", available: true });
    }
    if (path.endsWith("/providers")) return json({ providers: [], bindings: [] });
    if (path.endsWith("/git-credentials")) return json({ hasToken: true });
    if (path.endsWith("/repository-fetch")) return json({ fetched: true, head: "b".repeat(40) });
    if (path.endsWith("/git-credentials/test"))
      return json({ readable: true, pushVerified: false });
    if (path.endsWith("/repository-imports")) {
      if (method !== "GET") {
        expect(body.clientRequestId).toBeTruthy();
        imported = true;
        return json({ id: "import-1", status: "succeeded", projectId: "cloud-project" });
      }
      return json({
        imports: imported
          ? [
              {
                id: "import-1",
                status: "succeeded",
                repository: "https://github.com/owner/repository.git",
                projectId: "cloud-project",
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/tasks")) return json({ tasks: [] });
    if (path.endsWith("/projects"))
      return json({
        projects: [
          {
            id: path.includes("office") ? "office-project" : "cloud-project",
            name: "IM",
            workspaceId: path.includes("office") ? "office-project" : "cloud-project",
            branch: "main",
          },
        ],
      });
    if (path.endsWith("/git/status"))
      return json({ files: [{ path: "code.txt", kind: "modified", previousPath: null }] });
    if (path === "/api/v1/device-pairings" || path === "/api/v1/device-pairings/pair-1")
      return json({
        id: "pair-1",
        code: "A".repeat(24),
        expiresAt: "2099-01-01T00:00:00Z",
        device: {
          ...device,
          state: paired ? "active" : "pending",
          projects: paired ? ["office-project"] : [],
        },
      });
    if (path.endsWith("/pair-1/confirm")) {
      expect(body.projects).toEqual(["office-project"]);
      expect(body.fingerprint).toBe(device.fingerprint);
      paired = true;
      return json({ device: { ...device, state: "active", projects: ["office-project"] } });
    }
    if (path.endsWith("/office/revoke")) {
      revoked = true;
      return json({ revoked: true });
    }
    if (path.endsWith("/snapshots")) {
      expect(body.files).toEqual(["code.txt"]);
      return json({ snapshotId: "snapshot-1" });
    }
    if (path === "/api/v1/transfers")
      return json(method === "GET" ? { transfers: [] } : { ...transfer, state: transferState });
    if (path.endsWith("/transfer-1/resume")) {
      transferState = "ready";
      return json({ ...transfer, state: transferState });
    }
    if (path.endsWith("/transfer-1/import")) {
      expect(body.manifestDigest).toBe(transfer.manifestDigest);
      transferState = "verified";
      return json({
        ...transfer,
        state: transferState,
        result: { projectId: "recovery", branch: "recovery/test" },
      });
    }
    if (path.endsWith("/transfer-1")) return json({ ...transfer, state: transferState });
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: path } } });
  });
  return writes;
}

test("pairs only selected projects after fingerprint confirmation and requires an explicit revoke", async ({
  page,
}) => {
  const writes = await gateway(page);
  await page.goto("/cloud.html");
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /公司电脑连接/ }).click();
  await page.getByRole("button", { name: "创建一次性配对码" }).click();
  await expect(page.getByText("a".repeat(64), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "指纹一致，授权所选项目" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /IM/ }).check();
  await page.getByRole("button", { name: "指纹一致，授权所选项目" }).click();
  await expect(page.getByText("配对完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤销连接", exact: true }).click();
  expect(writes.some((w) => w.path.endsWith("/revoke"))).toBe(false);
  await page.getByRole("button", { name: "确认撤销 Office PC" }).click();
  await expect(page.getByRole("button", { name: "撤销连接", exact: true })).toHaveCount(0);
});

test("authorizes Codex for the selected host and clears the device code after login", async ({
  page,
}) => {
  const writes = await gateway(page);
  await page.goto("/cloud.html");
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Codex 授权/ }).click();
  await page.getByRole("button", { name: "在此宿主登录 Codex" }).click();
  await expect(page.getByText("TEST-DEVICE", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开 OpenAI 授权页面" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  await page.getByRole("button", { name: "检查授权状态" }).click();
  await expect(page.getByText("Codex 已就绪", { exact: true })).toBeVisible();
  await expect(page.getByText("TEST-DEVICE", { exact: true })).toHaveCount(0);
  expect(writes.map((w) => w.path)).toContain("/api/v1/hosts/cloud/executors/codex/login");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    "TEST-DEVICE",
  );
});

test("configures repository credentials without persisting secrets and imports with an explicit request", async ({
  page,
}) => {
  const writes = await gateway(page);
  await page.goto("/cloud.html");
  await page.getByRole("button", { name: /添加项目/ }).click();
  await page
    .getByLabel("仓库地址", { exact: true })
    .fill("https://github.com/owner/repository.git");
  await page.getByText("私有仓库访问凭据", { exact: true }).click();
  await page.getByLabel("仓库 token", { exact: true }).fill("test-token-private");
  await page.getByRole("button", { name: "保存访问凭据" }).click();
  await expect(page.getByLabel("仓库 token", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "检查仓库访问" }).click();
  await expect(page.getByText(/仓库可读取/)).toBeVisible();
  await page.getByLabel("Git 提交姓名", { exact: true }).fill("Owner");
  await page.getByLabel("Git 提交邮箱", { exact: true }).fill("owner@example.test");
  expect(writes.some((write) => write.path.endsWith("/repository-imports"))).toBe(false);
  await page.getByRole("button", { name: "导入为云端项目" }).click();
  await expect(page.getByText("导入完成", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    "test-token-private",
  );
  await page.screenshot({ path: "test-results/repository-setup-mobile.png", fullPage: true });
});

test("resumes a selected snapshot and imports only after manifest confirmation", async ({
  page,
}) => {
  const writes = await gateway(page);
  await page.goto("/cloud.html");
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /取回遗留改动/ }).click();
  await page.getByLabel("来源电脑").selectOption("office");
  await page.getByLabel("来源项目").selectOption("office-project");
  await page.getByLabel("云端对应仓库").selectOption("cloud-project");
  await page.getByText("云端缺少电脑上的 Git 提交", { exact: true }).click();
  await expect(page.getByRole("button", { name: "获取已批准推送的基线" })).toBeDisabled();
  await page.getByLabel("远端临时分支").fill("refs/heads/recovery/office");
  expect(writes.some((w) => w.path.endsWith("/repository-fetch"))).toBe(false);
  await page.getByRole("button", { name: "获取已批准推送的基线" }).click();
  await expect(
    page.getByText("基线提交已获取，请重新点击采集与传输。", { exact: true }),
  ).toBeVisible();
  expect(writes.find((w) => w.path.endsWith("/repository-fetch"))?.body).toEqual({
    projectId: "cloud-project",
    ref: "refs/heads/recovery/office",
  });
  await page.getByRole("checkbox", { name: /code.txt/ }).check();
  await page.getByRole("button", { name: "采集所选文件并传到云端" }).click();
  await expect(page.getByText("传输已暂停", { exact: true })).toBeVisible();
  expect(writes.some((w) => w.path.endsWith("/import"))).toBe(false);
  await page.getByRole("button", { name: "继续传输" }).click();
  await page.getByText("查看恢复清单与排除项").click();
  await expect(page.getByText("排除：.env", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "按此清单恢复到新工作区" }).click();
  await expect(page.getByText("恢复已验证", { exact: true })).toBeVisible();
  expect(writes.filter((w) => w.path.endsWith("/import"))).toHaveLength(1);
});

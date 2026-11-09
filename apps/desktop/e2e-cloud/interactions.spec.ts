import { expect, test, type Page, type Route } from "@playwright/test";

type Payload = Record<string, unknown>;
type Write = { path: string; body: Payload; csrf: string | undefined };

const ui = {
  workspace: "\u5de5\u4f5c\u533a",
  settings: "\u8bbe\u7f6e",
  git: "Git \u64cd\u4f5c",
  message: "\u63d0\u4ea4\u8bf4\u660e",
  preview: "\u751f\u6210 Git \u9884\u89c8",
  commit: "\u6279\u51c6\u5e76\u63d0\u4ea4",
  previewPush: "\u9884\u89c8\u63a8\u9001",
  push: "\u6279\u51c6\u5e76\u63a8\u9001",
  host: "\u5f53\u524d\u6267\u884c\u5bbf\u4e3b",
  provider: "\u6a21\u578b Provider",
  addProvider: "\u6dfb\u52a0 Provider",
  bot: "\u7528\u4e8e Bot \u4efb\u52a1",
  currentBot: "Bot \u5f53\u524d\u6a21\u578b",
};
const now = "2026-11-09T12:00:00.000Z";
const diff = "diff --git a/src/auth.ts b/src/auth.ts\n-old-session\n+private-session-fix";
const task = {
  id: "task-1",
  title: "Repair session state",
  goal: "Check the private session regression",
  agent: "code",
  conversationId: "conversation-1",
  requiresPlanApproval: true,
  status: "running",
  currentRunId: "run-1",
  pendingApprovalId: null,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
};
const provider = {
  id: "provider-1",
  name: "Test provider with a deliberately long display name",
  api: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  models: ["test-model"],
  defaultModel: "test-model",
  source: "manual",
  enabled: true,
  hasKey: true,
  createdAt: now,
  updatedAt: now,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "Cache-Control": "no-store" },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mockGateway(page: Page) {
  const state = {
    writes: [] as Write[],
    reads: [] as string[],
    unexpected: [] as string[],
    expired: false,
    failCommitOnce: false,
    failCreateOnce: false,
    completed: false,
    taskReads: 0,
    bindings: [] as Payload[],
    providers: [provider],
    previewGate: null as ReturnType<typeof deferred> | null,
    eventsGate: null as ReturnType<typeof deferred> | null,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? {} : (request.postDataJSON() as Payload);
    if (method !== "GET")
      state.writes.push({ path, body, csrf: request.headers()["x-csrf-token"] });
    else state.reads.push(`${path}${url.search}`);
    if (state.expired)
      return json(route, { error: { code: "UNAUTHORIZED", message: "Session expired" } }, 401);
    if (path === "/api/v1/session")
      return json(route, {
        user: { id: "owner-1", email: "owner@example.test", role: "owner" },
        session: { id: "session-1", expiresAt: "2099-01-01T00:00:00Z", recentAuthAt: now },
        csrfToken: "test-csrf",
      });
    if (path === "/api/v1/hosts")
      return json(route, {
        hosts: ["cloud", "office"].map((id) => ({
          id,
          name: `${id} host`,
          kind: id,
          status: "online",
          lastSeen: now,
          capabilities: ["task.create", "git.preview"],
        })),
      });
    if (path === "/api/v1/approvals") return json(route, { approvals: [] });
    const match = /^\/api\/v1\/hosts\/(cloud|office)(\/.*)$/.exec(path);
    const host = match?.[1];
    const tail = match?.[2];
    if (tail === "/projects")
      return json(route, {
        projects: [
          {
            id: `${host}-project`,
            name: `${host}-repo`,
            workspaceId: `${host}-workspace`,
            branch: "main",
          },
        ],
      });
    if (tail === "/tasks") return json(route, { tasks: host === "cloud" ? [task] : [] });
    if (tail === "/tasks/task-1") {
      state.taskReads++;
      return json(route, {
        task: { ...task, status: state.completed ? "completed" : "running" },
        runs: [
          {
            id: "run-1",
            taskId: task.id,
            status: state.completed ? "succeeded" : "running",
            resultText: state.completed ? "Final verified task result" : null,
          },
        ],
        approvals: [],
      });
    }
    if (tail === "/tasks/task-1/events") {
      if (!state.eventsGate)
        return route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" });
      await state.eventsGate.promise;
      state.completed = true;
      const event = {
        seq: 1,
        taskId: task.id,
        runId: "run-1",
        createdAt: now,
        event: { type: "run_ended", status: "succeeded" },
      };
      return route.fulfill({
        contentType: "text/event-stream",
        body: [event, event].map((value) => `id: 1\ndata: ${JSON.stringify(value)}\n\n`).join(""),
      });
    }
    if (tail === "/executors")
      return json(route, {
        executors: [
          { id: "native-bot", available: true },
          { id: "codex", available: false },
        ],
      });
    if (tail === "/providers")
      return json(route, { providers: state.providers, bindings: state.bindings });
    if (tail === "/providers/new" && method === "PUT") {
      state.providers = [
        ...state.providers,
        { ...provider, ...body, id: "provider-2", hasKey: true },
      ];
      return json(route, { provider: { ...provider, id: "provider-2", name: body.name } });
    }
    if (tail === "/provider-bindings" && method === "PUT") {
      state.bindings = body.bindings as Payload[];
      return json(route, { bindings: state.bindings });
    }
    if (tail === `/projects/${host}-project/tasks` && method === "POST") {
      if (state.failCreateOnce) {
        state.failCreateOnce = false;
        return json(
          route,
          { error: { code: "UNAVAILABLE", message: "Create response unavailable" } },
          503,
        );
      }
      return json(route, { task });
    }
    if (tail === `/projects/${host}-project/git/status`)
      return json(route, {
        head: "a".repeat(40),
        branch: "refs/heads/main",
        files: ["src/auth.ts", "notes.txt"].map((path) => ({
          path,
          previousPath: null,
          indexStatus: " ",
          worktreeStatus: "M",
          kind: "modified",
        })),
      });
    if (tail === `/projects/${host}-project/git/preview`) {
      await state.previewGate?.promise;
      return json(route, {
        operation: {
          status: "succeeded",
          result: {
            previewId: `${host}-${body.kind}-preview`,
            approvalId: `${host}-${body.kind}-approval`,
            version: 1,
            actionDigest: `${host}-${body.kind}-digest`,
            expiresAt: "2099-01-01T00:00:00Z",
            state: { head: "a".repeat(40), branch: "refs/heads/main" },
            ...(body.kind === "commit"
              ? { files: body.files, message: body.message, diff }
              : {
                  remote: body.remote,
                  ref: body.ref,
                  remoteUrl: "https://git.example.test/project.git",
                  remoteHead: "b".repeat(40),
                  commits: [{ sha: "c".repeat(40), subject: "Fix session state" }],
                }),
          },
        },
        replayed: false,
      });
    }
    if (tail?.match(/^\/approvals\/[^/]+\/resolve$/)) return json(route, { resolved: true });
    if (
      tail === `/projects/${host}-project/git/commit` ||
      tail === `/projects/${host}-project/git/push`
    ) {
      if (tail.endsWith("/commit") && state.failCommitOnce) {
        state.failCommitOnce = false;
        return json(
          route,
          { error: { code: "UNAVAILABLE", message: "Commit response unavailable" } },
          503,
        );
      }
      return json(route, {
        operation: { status: "succeeded", result: { head: "c".repeat(40) } },
        replayed: false,
      });
    }
    state.unexpected.push(`${method} ${path}`);
    return json(route, { error: { code: "NOT_FOUND", message: "Missing mock route" } }, 404);
  });
  return state;
}

async function openApp(page: Page) {
  await page.goto("/cloud.html");
  await expect(page.getByRole("button", { name: /cloud-repo/ })).toBeVisible();
}

async function openGit(page: Page, host = "cloud") {
  await page.getByRole("button", { name: new RegExp(`${host}-repo`) }).click();
  await page.getByRole("button", { name: new RegExp(ui.git) }).click();
  await expect(page.getByRole("checkbox", { name: /src\/auth.ts/ })).toBeVisible();
}

async function openProviders(page: Page) {
  await page.getByRole("tab", { name: ui.settings, exact: true }).click();
  await page.getByRole("button", { name: new RegExp(ui.provider) }).click();
}

test("Git selected scope, approval order, stable retry and separate push", async ({ page }) => {
  const state = await mockGateway(page);
  state.failCommitOnce = true;
  await openApp(page);
  await openGit(page);
  await page.getByRole("checkbox", { name: /src\/auth.ts/ }).check();
  await page.getByLabel(ui.message).fill("Fix session state");
  await page.getByRole("button", { name: new RegExp(ui.preview) }).click();
  await expect(page.locator(".m-diff")).toHaveText(diff);
  expect(state.writes[0]?.body).toMatchObject({
    kind: "commit",
    files: ["src/auth.ts"],
    message: "Fix session state",
  });
  expect(state.writes).toHaveLength(1);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({ path: "test-results/cloud-git-preview.png", fullPage: true });
  await page.getByRole("button", { name: ui.commit, exact: true }).click();
  await expect(page.getByText("Commit response unavailable")).toBeVisible();
  await page.getByRole("button", { name: ui.commit, exact: true }).click();
  await expect(page.getByRole("button", { name: ui.commit, exact: true })).toHaveCount(0);
  expect(state.writes.map(({ path }) => path.split("/").at(-1))).toEqual([
    "preview",
    "resolve",
    "commit",
    "resolve",
    "commit",
  ]);
  expect(state.writes[1]?.body).toEqual(state.writes[3]?.body);
  expect(state.writes[2]?.body).toEqual(state.writes[4]?.body);
  expect(state.writes[2]?.body).toMatchObject({
    previewId: "cloud-commit-preview",
    approvalId: "cloud-commit-approval",
    version: 1,
    actionDigest: "cloud-commit-digest",
  });
  expect(state.writes.every(({ csrf }) => csrf === "test-csrf")).toBe(true);
  await page.getByRole("button", { name: ui.previewPush, exact: true }).click();
  await expect(page.getByRole("button", { name: ui.push, exact: true })).toBeVisible();
  expect(state.writes.at(-1)?.body).toMatchObject({
    kind: "push",
    remote: "origin",
    ref: "refs/heads/main",
  });
  expect(state.writes.some(({ path }) => path.endsWith("/push"))).toBe(false);
  await page.getByRole("button", { name: ui.push, exact: true }).click();
  await expect(page.getByRole("button", { name: ui.push, exact: true })).toHaveCount(0);
  expect(state.writes.slice(-3).map(({ path }) => path.split("/").at(-1))).toEqual([
    "preview",
    "resolve",
    "push",
  ]);
  expect(state.writes.at(-1)?.body).toMatchObject({
    previewId: "cloud-push-preview",
    approvalId: "cloud-push-approval",
    actionDigest: "cloud-push-digest",
  });
  expect(state.unexpected).toEqual([]);
});

test("host switch discards a delayed preview and resets Git selection", async ({ page }) => {
  const state = await mockGateway(page);
  state.previewGate = deferred();
  await openApp(page);
  await openGit(page);
  await page.getByRole("checkbox", { name: /src\/auth.ts/ }).check();
  await page.getByLabel(ui.message).fill("Old host message");
  await page.getByRole("button", { name: new RegExp(ui.preview) }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole("tab", { name: ui.workspace, exact: true }).click();
  await page.getByRole("combobox", { name: ui.host }).selectOption("office");
  state.previewGate.resolve();
  await expect(page.getByRole("button", { name: /office-repo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /cloud-repo/ })).toHaveCount(0);
  await openGit(page, "office");
  await expect(page.getByRole("checkbox", { name: /src\/auth.ts/ })).not.toBeChecked();
  await expect(page.getByLabel(ui.message)).toHaveValue("");
  await expect(page.locator(".m-diff")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /notes.txt/ }).check();
  await page.getByLabel(ui.message).fill("Office host message");
  await page.getByRole("button", { name: new RegExp(ui.preview) }).click();
  await expect(page.locator(".m-diff")).toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({
    path: "/api/v1/hosts/office/projects/office-project/git/preview",
    body: { files: ["notes.txt"], message: "Office host message" },
  });
  expect(
    state.reads.some((path) => path.includes("/hosts/office/tasks?projectId=cloud-project")),
  ).toBe(false);
  expect(state.unexpected).toEqual([]);
});

test("run_ended refreshes the snapshot and duplicate events render once", async ({ page }) => {
  const state = await mockGateway(page);
  state.eventsGate = deferred();
  await openApp(page);
  await page.getByRole("button", { name: /Repair session state/ }).click();
  await expect(page.getByText(task.goal, { exact: true })).toBeVisible();
  const previousReads = state.taskReads;
  state.eventsGate.resolve();
  await expect(page.getByText("Final verified task result", { exact: true })).toBeVisible();
  expect(state.taskReads).toBeGreaterThan(previousReads);
  await expect(page.getByText("run ended", { exact: true })).toHaveCount(1);
  expect(state.unexpected).toEqual([]);
});

test("Provider save and Bot binding are explicit and write actions disable offline", async ({
  page,
  context,
}) => {
  const state = await mockGateway(page);
  await openApp(page);
  await openProviders(page);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByText(provider.name, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: "test-results/cloud-providers.png", fullPage: true });
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: ui.bot, exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
  await context.setOffline(false);
  await page.getByRole("button", { name: ui.bot, exact: true }).click();
  await expect(page.getByRole("button", { name: ui.currentBot, exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    path: "/api/v1/hosts/cloud/provider-bindings",
    body: {
      bindings: ["orchestrator", "code", "reviewer"].map((agent) => ({
        agent,
        providerId: provider.id,
        model: provider.defaultModel,
        fallbackProviderIds: [],
      })),
    },
  });
  await page.getByRole("button", { name: ui.addProvider, exact: true }).click();
  await page.getByLabel("\u540d\u79f0", { exact: true }).fill("New model service");
  await page.getByLabel("API \u5730\u5740").fill("https://api.example.test/v1");
  await page.getByLabel(/\u6a21\u578b ID/).fill("model-one\nmodel-two");
  await page.getByLabel(/API \u5bc6\u94a5/).fill("private-test-key");
  await page.getByRole("button", { name: "\u4fdd\u5b58\u914d\u7f6e" }).click();
  await expect(page.getByText("New model service", { exact: true })).toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({
    path: "/api/v1/hosts/cloud/providers/new",
    body: {
      name: "New model service",
      api: "openai-completions",
      baseUrl: "https://api.example.test/v1",
      models: ["model-one", "model-two"],
      defaultModel: "model-one",
      apiKey: "private-test-key",
      enabled: true,
      source: "manual",
    },
  });
  expect(state.writes.some(({ path }) => path.endsWith("/test"))).toBe(false);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain("private-test-key");
  expect(state.unexpected).toEqual([]);
});

test("401 clears private task, diff and unsaved provider fields", async ({ page }) => {
  const state = await mockGateway(page);
  await openApp(page);
  await openGit(page);
  await page.getByRole("checkbox", { name: /src\/auth.ts/ }).check();
  await page.getByLabel(ui.message).fill("private-commit-message");
  await page.getByRole("button", { name: new RegExp(ui.preview) }).click();
  await expect(page.locator(".m-diff")).toBeVisible();
  await openProviders(page);
  await page.getByRole("button", { name: ui.addProvider, exact: true }).click();
  await page.getByLabel("\u540d\u79f0", { exact: true }).fill("Private unsaved provider");
  await page.getByLabel("API \u5730\u5740").fill("https://api.example.test/v1");
  await page.getByLabel(/\u6a21\u578b ID/).fill("private-model");
  await page.getByLabel(/API \u5bc6\u94a5/).fill("private-unsaved-key");
  state.expired = true;
  await page.getByRole("button", { name: "\u4fdd\u5b58\u914d\u7f6e" }).click();
  await expect(page.getByLabel("\u90ae\u7bb1\u5730\u5740")).toBeVisible();
  const content = await page.locator("body").innerText();
  for (const secret of [
    task.goal,
    "private-session-fix",
    "private-commit-message",
    "Private unsaved provider",
    "private-unsaved-key",
  ])
    expect(content).not.toContain(secret);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
});

test("task submission retries retain the same request id", async ({ page }) => {
  const state = await mockGateway(page);
  state.failCreateOnce = true;
  await openApp(page);
  await page.getByRole("button", { name: "\u65b0\u5efa\u4efb\u52a1", exact: true }).click();
  await page.getByLabel("\u4f60\u60f3\u5b8c\u6210\u4ec0\u4e48\uff1f").fill("Repair this project");
  await page
    .locator("form")
    .getByRole("button", { name: /\u4efb\u52a1/ })
    .click();
  await expect(page.getByText("Create response unavailable")).toBeVisible();
  await page
    .locator("form")
    .getByRole("button", { name: /\u4efb\u52a1/ })
    .click();
  await expect(page.getByRole("heading", { name: task.title })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]?.body).toEqual(state.writes[1]?.body);
  expect(state.writes[0]?.body).toMatchObject({ executor: "native-bot" });
  expect(state.unexpected).toEqual([]);
});

test("Service Worker caches public shell while API responses stay unavailable offline", async ({
  page,
  context,
}) => {
  await page.goto("/cloud.html");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/cloud-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        }),
      );
  });
  await page.route("**/api/v1/private-probe", (route) =>
    json(route, { secret: "private-cache-probe" }),
  );
  expect(await page.evaluate(async () => (await fetch("/api/v1/private-probe")).json())).toEqual({
    secret: "private-cache-probe",
  });
  const keys = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname),
        ),
      )
    ).flat(),
  );
  expect(keys).toContain("/cloud.html");
  expect(keys).toContain("/cloud-icon.svg");
  expect(keys.some((path) => path.startsWith("/api/"))).toBe(false);
  await page.unroute("**/api/v1/private-probe");
  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    const publicAsset = await fetch("/cloud-icon.svg");
    const privateData = await fetch("/api/v1/private-probe").then(
      () => true,
      () => false,
    );
    const query = await fetch("/cloud.html?private=query").then(
      () => true,
      () => false,
    );
    return { publicAsset: publicAsset.ok, privateData, query };
  });
  expect(offline).toEqual({ publicAsset: true, privateData: false, query: false });
});

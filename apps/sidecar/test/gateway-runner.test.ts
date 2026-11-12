import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import type { RemoteApprovalContext, RunEventRecord } from "@agentdesk/shared";
import { createGatewayApp } from "../../cloud-gateway/src/app";
import { createGatewayAuth } from "../../cloud-gateway/src/auth/service";
import { parseTrustedProxies, type GatewayConfig } from "../../cloud-gateway/src/config";
import { GatewayStore } from "../../cloud-gateway/src/db/store";
import { RunnerClient } from "../../cloud-gateway/src/remote/client";
import { RemoteGatewayService } from "../../cloud-gateway/src/remote/service";
import { RemoteRoutingStore } from "../../cloud-gateway/src/remote/store";
import { GatewayTransfers } from "../../cloud-gateway/src/remote/transfers";
import { createCloudApp } from "../src/cloud-app";
import { loadCloudConfig } from "../src/cloud-config";
import { createContainer, type Container } from "../src/container";
import type { RepositoryPreview } from "../src/services/remote/repository-operations";
import { RepositoryOperationService } from "../src/services/remote/repository-operations";
import { RemoteOperationStore } from "../src/services/remote/operations";
let root: string;
let workspace: string;
let db: Database.Database;
let config: GatewayConfig;
let container: Container;
let server: ReturnType<typeof serve>;
let app: ReturnType<typeof createGatewayApp>;
let remote: RemoteGatewayService;
let routing: RemoteRoutingStore;
let faux: FauxProviderRegistration;
let headers: Record<string, string>;
let projectId: string;
let dropSubmissionResponse: boolean;
let submissions: number;
let transfers: GatewayTransfers;
let dropChunkResponse: boolean;
const request = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(`${config.publicOrigin}/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: "agent.example.test",
      origin: config.publicOrigin,
      "content-type": "application/json",
      ...headers,
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-gateway-runner-"));
  const workspaceRoot = join(root, "workspaces");
  workspace = join(workspaceRoot, "example");
  mkdirSync(workspace, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Remote Test");
  git("config", "user.email", "remote@test.invalid");
  writeFileSync(join(workspace, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-m", "chore: initial");
  config = {
    publicOrigin: "https://agent.example.test",
    ownerEmail: "owner@example.test",
    authMultiUser: false,
    dataDir: join(root, "gateway"),
    host: "127.0.0.1",
    port: 3000,
    sessionSecret: randomBytes(32).toString("hex"),
    otpPepper: randomBytes(32).toString("hex"),
    remoteToken: randomBytes(32).toString("hex"),
    runnerUrl: "http://127.0.0.1",
    cloudHostName: "Local cloud runner",
    cloudWorkspaceRoot: workspaceRoot,
    providerHostAllowlist: ["api.openai.com"],
    trustedProxies: parseTrustedProxies("127.0.0.1/32"),
    smtp: {
      host: "smtp.example.test",
      port: 465,
      secure: true,
      user: "owner",
      password: "test",
      from: "owner@example.test",
    },
  };
  db = new Database(":memory:");
  const store = new GatewayStore(db, config.otpPepper);
  let otp = "";
  const auth = await createGatewayAuth(config, db, async (_email, value) => {
    otp = value;
  });
  const owner = db.prepare('SELECT id FROM "user"').get() as {
    id: string;
  };
  const masterFile = join(root, "master.key");
  const tokenFile = join(root, "remote.key");
  writeFileSync(masterFile, randomBytes(32).toString("base64"));
  writeFileSync(tokenFile, config.remoteToken);
  const cloud = loadCloudConfig({
    AGENTDESK_DATA_DIR: join(root, "runner"),
    WORKSPACE_ROOT: workspaceRoot,
    AGENTDESK_MASTER_KEY_FILE: masterFile,
    REMOTE_SHARED_TOKEN_FILE: tokenFile,
    CLOUD_OWNER_USER_ID: owner.id,
  });
  container = await createContainer(cloud, {
    inMemory: true,
    cloud: { hostId: cloud.hostId, workspaceRoot, taskTimeoutMs: 60000 },
  });
  await container.cloudRunner!.registerConfiguredWorkspaces();
  // 测试仅向临时 bare 仓库推送；生产仍仅允许明确配置的网络 Git 主机。
  container.repositoryOperations = new RepositoryOperationService({
    grants: container.remoteGrants!,
    operations: new RemoteOperationStore(container.dbHandle.raw),
    approvals: container.approvals,
    remoteApprovals: container.remoteApprovals!,
    resolveWorkspace: async (scope) => await container.cloudRunner!.resolveWorkspace(scope),
    locks: container.cloudRunner!.locks,
    allowLocalRemotes: true,
  });
  projectId = (await container.projects.list())[0]!.id;
  faux = registerFauxProvider({ tokensPerSecond: 100000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
  ];
  server = serve({ fetch: createCloudApp(container, cloud).fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runner did not bind a TCP port");
  config.runnerUrl = `http://127.0.0.1:${address.port}`;
  dropSubmissionResponse = false;
  submissions = 0;
  dropChunkResponse = false;
  const client = new RunnerClient(config, async (url, init) => {
    const action = init?.body ? JSON.parse(String(init.body)).command?.action : undefined;
    if (action === "task.create") submissions++;
    const response = await fetch(url, init);
    if (
      action === "transfer.import" &&
      JSON.parse(String(init?.body)).payload?.kind === "upload" &&
      dropChunkResponse
    ) {
      dropChunkResponse = false;
      await response.body?.cancel();
      throw new Error("Chunk accepted but response lost");
    }
    if (action === "task.create" && dropSubmissionResponse) {
      dropSubmissionResponse = false;
      await response.body?.cancel();
      throw new Error("Simulated connection loss after Runner accepted the task");
    }
    return response;
  });
  routing = new RemoteRoutingStore(db);
  remote = new RemoteGatewayService(client, routing);
  transfers = new GatewayTransfers(db, remote, routing);
  app = createGatewayApp({
    config,
    auth,
    store,
    runner: client,
    remote,
    routing,
    transfers,
    peerAddress: () => "127.0.0.1",
  });
  headers = {};
  const csrf = await request("auth/csrf");
  headers = {
    cookie: csrf.headers.getSetCookie()[0]!.split(";")[0]!,
    "x-csrf-token": (await csrf.json()).csrfToken,
  };
  expect((await request("auth/otp/request", { email: config.ownerEmail })).status).toBe(202);
  const login = await request("auth/otp/verify", { email: config.ownerEmail, otp });
  expect(login.status).toBe(200);
  headers = {
    cookie: login.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agentdesk_session="))!
      .split(";")[0]!,
  };
  const session = await (await request("session")).json();
  headers["x-csrf-token"] = session.csrfToken;
}, 20000);
afterEach(async () => {
  await transfers?.stop();
  await remote?.stop();
  if (container) {
    for (const task of await container.tasks.list())
      if (task.currentRunId) await container.tasks.requestCancel(task.currentRunId);
    await expect
      .poll(async () =>
        (
          await Promise.all(
            (await container.tasks.list()).map(
              async (task) =>
                !task.currentRunId ||
                (await container.tasks.getRun(task.currentRunId))?.status !== "running",
            ),
          )
        ).every(Boolean),
      )
      .toBe(true);
    await container.dispose();
  }
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  faux?.unregister();
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("recovers a real snapshot through the Gateway and Runner, resumes a lost chunk response and confirms the exact imported workspace", async () => {
  const destination = join(config.cloudWorkspaceRoot, "destination");
  execFileSync("git", ["clone", "--no-hardlinks", workspace, destination], { stdio: "pipe" });
  const target = await container.projects.add(destination);
  const bytes = Buffer.alloc(130000, 0x85);
  writeFileSync(join(workspace, "image.bin"), bytes);
  writeFileSync(join(workspace, "README.md"), "recovered change\n");
  writeFileSync(join(workspace, ".env"), "SECRET=exclude");
  const sourceStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const captured = await request(`hosts/cloud/projects/${projectId}/snapshots`, {
    clientRequestId: randomUUID(),
    files: ["README.md", "image.bin", ".env"],
  });
  expect(captured.status).toBe(201);
  const snapshot = await captured.json();
  const body = {
    clientRequestId: randomUUID(),
    sourceHostId: "cloud",
    sourceProjectId: projectId,
    snapshotId: snapshot.snapshotId,
    targetProjectId: target.id,
  };
  dropChunkResponse = true;
  const created = await request("transfers", body);
  expect(created.status).toBe(202);
  const first = await created.json();
  expect((await (await request("transfers", body)).json()).id).toBe(first.id);
  expect((await request("transfers", { ...body, targetProjectId: projectId })).status).toBe(409);
  await expect
    .poll(async () => (await (await request(`transfers/${first.id}`)).json()).state)
    .toBe("paused");
  expect(
    (await request(`transfers/${first.id}/import`, { manifestDigest: first.manifestDigest }))
      .status,
  ).toBe(409);
  expect((await request(`transfers/${first.id}/resume`, {})).status).toBe(202);
  await expect
    .poll(async () => (await (await request(`transfers/${first.id}`)).json()).state)
    .toBe("ready");
  expect(
    (await request(`transfers/${first.id}/import`, { manifestDigest: "0".repeat(64) })).status,
  ).toBe(409);
  const imported = await request(`transfers/${first.id}/import`, {
    manifestDigest: first.manifestDigest,
  });
  expect(imported.status).toBe(200);
  const recovered = await imported.json();
  expect(recovered.state).toBe("verified");
  const project = (await container.projects.get(recovered.result.projectId))!;
  expect(readFileSync(join(project.path, "image.bin"))).toEqual(bytes);
  expect(readFileSync(join(project.path, "README.md"), "utf8")).toBe("recovered change\n");
  expect(existsSync(join(project.path, ".env"))).toBe(false);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" })).toBe(
    sourceStatus,
  );
  expect(
    (
      await (
        await request(`transfers/${first.id}/import`, { manifestDigest: first.manifestDigest })
      ).json()
    ).result.projectId,
  ).toBe(project.id);
}, 30000);
function fileWrite() {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(toWireName("fs.write"), {
        project: projectId,
        path: "result.txt",
        content: "approved through gateway",
        expectedHash: "",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxText("The approved file was written")),
  ]);
}
const input = () => ({
  clientRequestId: randomUUID(),
  goal: "Write a file after mobile approval",
  executor: "native-bot",
  workspaceMode: "existing",
  workspaceId: projectId,
  requiresPlanApproval: false,
});
async function pending() {
  await expect.poll(async () => (await container.approvals.list("pending")).length).toBe(1);
  const response = await request("approvals");
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json();
  return result.approvals[0] as {
    approval: {
      id: string;
    };
    context: RemoteApprovalContext;
  };
}
describe("Gateway and Runner over HTTP", () => {
  it("previews selected files and separately approves an idempotent commit and push", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    git("remote", "add", "origin", bare);
    git("push", "-u", "origin", "main");
    writeFileSync(join(workspace, "README.md"), "reviewed change\n");
    writeFileSync(join(workspace, "unrelated.txt"), "keep this uncommitted\n");
    const base = `hosts/cloud/projects/${projectId}/git`;
    expect(await (await request(`${base}/status`)).json()).toMatchObject({
      branch: "main",
      files: expect.arrayContaining([
        {
          path: "README.md",
          kind: "modified",
          previousPath: null,
          indexStatus: " ",
          worktreeStatus: "M",
        },
      ]),
    });
    const execute = async (kind: "commit" | "push", payload: Record<string, unknown>) => {
      const previewResponse = await request(`${base}/preview`, {
        clientRequestId: randomUUID(),
        kind,
        ...payload,
      });
      expect(previewResponse.status, await previewResponse.clone().text()).toBe(201);
      const { operation } = await previewResponse.json();
      const preview = operation.result as RepositoryPreview;
      const approved = await request(`hosts/cloud/approvals/${preview.approvalId}/resolve`, {
        clientRequestId: randomUUID(),
        approved: true,
        version: preview.version,
        actionDigest: preview.actionDigest,
      });
      expect(approved.status, await approved.clone().text()).toBe(200);
      const body = {
        clientRequestId: randomUUID(),
        previewId: preview.previewId,
        approvalId: preview.approvalId,
        version: preview.version,
        actionDigest: preview.actionDigest,
      };
      const result = await request(`${base}/${kind}`, body);
      expect(result.status, await result.clone().text()).toBe(200);
      expect(await result.json()).toMatchObject({ operation: { status: "succeeded" } });
      const replay = await request(`${base}/${kind}`, body);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toMatchObject({
        replayed: true,
        operation: { status: "succeeded" },
      });
      return preview;
    };
    const preview = await execute("commit", {
      files: ["README.md"],
      message: "fix: reviewed change",
    });
    expect(preview.diff).toContain("reviewed change");
    expect(preview.diff).not.toContain("keep this uncommitted");
    expect(git("status", "--porcelain")).toBe("?? unrelated.txt");
    const sha = git("rev-parse", "HEAD");
    const push = await execute("push", { remote: "origin", ref: "refs/heads/main" });
    expect(push.approvalId).not.toBe(preview.approvalId);
    expect(
      execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(sha);
  }, 60000);
  it("logs in, submits once, renews without SSE, approves a real write and replays events", async () => {
    fileWrite();
    expect((await request("hosts", undefined, { cookie: "" })).status).toBe(401);
    const hosts = await request("hosts");
    expect(hosts.status, await hosts.clone().text()).toBe(200);
    expect(await hosts.json()).toMatchObject({ hosts: [{ id: "cloud", status: "online" }] });
    const projects = await request("hosts/cloud/projects");
    expect(await projects.json()).toMatchObject({ projects: [{ id: projectId }] });
    const body = input();
    const path = `hosts/cloud/projects/${projectId}/tasks`;
    expect((await request(path, body, { "x-csrf-token": "forged" })).status).toBe(403);
    const accepted = await request(path, body);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const { task, run } = await accepted.json();
    const duplicate = await request(path, body);
    expect(duplicate.status, await duplicate.clone().text()).toBe(202);
    expect(await duplicate.json()).toMatchObject({ task: { id: task.id }, run: { id: run.id } });
    expect(await container.tasks.list()).toHaveLength(1);
    expect(await container.tasks.listRuns(task.id)).toHaveLength(1);
    expect((await request(path, { ...body, goal: "Changed request" })).status).toBe(409);
    const approval = await pending();
    expect(existsSync(join(workspace, "result.txt"))).toBe(false);
    // 模拟租期已消耗一部分，避免初次 45 秒授权与后台 40 秒续租窗口造成时序误判。
    const prior = new Date(Date.now() + 15000).toISOString();
    container.dbHandle.raw
      .prepare("UPDATE remote_task_contexts SET lease_expires_at=? WHERE task_id=?")
      .run(prior, task.id);
    await remote.renew();
    expect(
      Date.parse((await container.cloudRunner!.context(task.id)).leaseExpiresAt),
    ).toBeGreaterThan(Date.parse(prior));
    const resolved = await request(`hosts/cloud/approvals/${approval.approval.id}/resolve`, {
      clientRequestId: randomUUID(),
      approved: true,
      version: approval.context.version,
      actionDigest: approval.context.actionDigest,
    });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    await expect.poll(async () => (await container.tasks.getRun(run.id))?.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("approved through gateway");
    const detail = await request(`hosts/cloud/tasks/${task.id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await detail.json()).toMatchObject({ run: { id: run.id, status: "succeeded" } });
    const events = await request(`hosts/cloud/tasks/${task.id}/events?after=0`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const stream = await events.text();
    const records = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as RunEventRecord);
    expect(
      records.map(({ event }) => (event.type === "text_delta" ? event.delta : "")).join(""),
    ).toBe("The approved file was written");
    expect(records.at(-1)?.event).toMatchObject({ type: "run_ended", status: "succeeded" });
    const last = [...stream.matchAll(/^id: (\d+)$/gm)].at(-1)?.[1];
    expect(last).toBeDefined();
    const replay = await request(`hosts/cloud/tasks/${task.id}/events`, undefined, {
      "last-event-id": last!,
    });
    expect(await replay.text()).toBe("");
  }, 20000);
  it("revoking the login cancels approval waiting and prevents further task access", async () => {
    fileWrite();
    const response = await request(`hosts/cloud/projects/${projectId}/tasks`, input());
    expect(response.status, await response.clone().text()).toBe(202);
    const { task, run } = await response.json();
    await pending();
    expect((await request("sessions/revoke-all", {})).status).toBe(200);
    await remote.renew();
    await expect.poll(async () => (await container.tasks.getRun(run.id))?.status).toBe("cancelled");
    expect((await request(`hosts/cloud/tasks/${task.id}`)).status).toBe(401);
    expect(await routing.active()).toHaveLength(0);
    expect(existsSync(join(workspace, "result.txt"))).toBe(false);
  });
  it("reconciles a lost submit response without dispatching another task", async () => {
    fileWrite();
    dropSubmissionResponse = true;
    const response = await request(`hosts/cloud/projects/${projectId}/tasks`, input());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Simulated connection loss");
    await pending();
    expect((await routing.active())[0]?.taskId).toBeNull();
    await remote.renew();
    expect((await routing.active())[0]?.taskId).toBe((await container.tasks.list())[0]!.id);
    expect(await container.tasks.list()).toHaveLength(1);
    expect(submissions).toBe(1);
  });
});

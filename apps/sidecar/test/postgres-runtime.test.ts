import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import { RemoteCapability, type RemoteScope, type RemoteActor } from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { loadCloudConfig, type CloudConfig } from "../src/cloud-config";
import { createCloudApp } from "../src/cloud-app";
import { PostgresUnitOfWork } from "../src/db/postgres";
import { PostgresTaskPersistence } from "../src/services/storage/postgres-task-persistence";
import { PostgresMessages } from "../src/services/storage/postgres-messages";
import { PostgresRetentionStore } from "../src/services/storage/postgres-retention-store";
import { TaskSubmissionService } from "../src/services/task-submissions";
import { TaskService } from "../src/services/tasks";
import { EventHub } from "../src/events";
import { payloadDigest } from "../src/services/remote/digest";

const file = process.env.RUNNER_TEST_DATABASE_URL_FILE;
describe.skipIf(!file)("PostgreSQL Runner HTTP and lifecycle", () => {
  const schema =
    process.env.RUNNER_TEST_RUNTIME_SCHEMA ?? `runtime_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresUnitOfWork,
    store: PostgresTaskPersistence,
    container: Container,
    root: string,
    workspace: string,
    config: CloudConfig,
    app: ReturnType<typeof createCloudApp>,
    scope: RemoteScope,
    actor: RemoteActor,
    faux: FauxProviderRegistration;
  const call = (path: string, body?: unknown, method?: string) =>
    app.request(`/remote-api/v1${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "x-agentdesk-remote-token": config.remoteToken,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const command = (action: string, payload: unknown) =>
    call("/commands", {
      command: {
        ...scope,
        protocolVersion: 1,
        messageId: randomUUID(),
        requestId: (payload as { clientRequestId?: string }).clientRequestId ?? randomUUID(),
        actor,
        connectionEpoch: 1,
        action,
        payloadHash: payloadDigest(payload),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 25000).toISOString(),
      },
      payload,
    });
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const until = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > until) throw new Error("PG Runner condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pg-runner-"));
    workspace = join(root, "workspaces", "example");
    mkdirSync(workspace, { recursive: true });
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "PG Test"],
      ["config", "user.email", "pg@test.invalid"],
    ])
      execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "README.md"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "chore: fixture"], { cwd: workspace, stdio: "ignore" });
    const master = join(root, "master"),
      token = join(root, "token");
    writeFileSync(master, randomBytes(32).toString("base64"));
    writeFileSync(token, randomBytes(32).toString("hex"));
    config = loadCloudConfig({
      AGENTDESK_DATA_DIR: join(root, "data"),
      WORKSPACE_ROOT: join(root, "workspaces"),
      AGENTDESK_MASTER_KEY_FILE: master,
      REMOTE_SHARED_TOKEN_FILE: token,
      CLOUD_OWNER_USER_ID: "pg-owner",
    });
    db = await PostgresUnitOfWork.connect(readFileSync(file!, "utf8").trim(), schema);
    store = new PostgresTaskPersistence(db);
    await store.initialize();
    container = await createContainer(config, {
      persistence: store,
      messages: new PostgresMessages(db),
      retention: new PostgresRetentionStore(db),
      cloud: { hostId: config.hostId, workspaceRoot: config.workspaceRoot, taskTimeoutMs: 60000 },
    });
    await container.cloudRunner!.registerConfiguredWorkspaces();
    const project = (await container.projects.list())[0]!;
    scope = {
      userId: config.ownerUserId,
      hostId: config.hostId,
      projectId: project.id,
      workspaceId: project.id,
    };
    actor = {
      userId: scope.userId,
      sessionId: "pg-session",
      recentAuthAt: new Date().toISOString(),
    };
    app = createCloudApp(container, config);
    assert.equal(
      (
        await call(
          "/grants",
          {
            ...scope,
            capabilities: RemoteCapability.options,
            connectionEpoch: 1,
            expiresAt: new Date(Date.now() + 45000).toISOString(),
            revokedAt: null,
          },
          "PUT",
        )
      ).status,
      200,
    );
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
    container.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "fixture" },
    ];
  }, 30000);
  afterAll(async () => {
    await container?.dispose();
    faux?.unregister();
    if (db) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }, 30000);
  it("commits one complete resource graph for concurrent idempotent submissions and rolls back injected failure", async () => {
    const service = new TaskSubmissionService(container.dbHandle, container.tasks);
    const input = { goal: "atomic graph", idempotencyKey: randomUUID() };
    const results = await Promise.all([service.submit(input), service.submit(input)]);
    assert.equal(results[0]!.run.id, results[1]!.run.id);
    assert.equal(results.filter((value) => value.replayed).length, 1);
    const before = (await store.documents("conversations").list()).length;
    await assert.rejects(
      container.tasks.transaction(async () => {
        await service.submit({ goal: "rollback graph", idempotencyKey: randomUUID() });
        throw new Error("injected");
      }),
      /injected/,
    );
    assert.equal((await store.documents("conversations").list()).length, before);
    await container.tasks.requestCancel(results[0]!.run.id);
    await container.tasks.enqueue(results[0]!.run.id);
    await waitFor(
      async () => (await container.tasks.getRun(results[0]!.run.id))?.status === "cancelled",
    );
  });
  it("does not wake an approval waiter when its decision transaction rolls back", async () => {
    const pending = await container.approvals.create({
      kind: "tool",
      title: "rollback decision",
      detail: "test",
      risk: "confirm",
      payload: {},
    });
    let woke = false;
    const waited = pending.wait().then((result) => {
      woke = true;
      return result;
    });
    await assert.rejects(
      container.tasks.transaction(async () => {
        await container.approvals.resolve(pending.approval.id, true);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(woke, false);
    assert.equal((await container.approvals.get(pending.approval.id))?.status, "pending");
    await container.approvals.resolve(pending.approval.id, false);
    assert.equal(await waited, false);
  });
  it("executes a real file write only after HTTP approval and reads persisted messages, events, artifacts and scope", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "result.txt",
          content: "postgres verified",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("written")),
    ]);
    const input = {
      clientRequestId: randomUUID(),
      goal: "Write result",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: scope.workspaceId,
      requiresPlanApproval: false,
    };
    const response = await command("task.create", input);
    assert.equal(response.status, 201, await response.clone().text());
    const accepted = await response.json();
    await waitFor(async () => {
      const pending = (await container.approvals.list("pending"))[0];
      return !!pending && !!(await container.remoteApprovals!.get(scope, pending.id));
    });
    assert.equal(existsSync(join(workspace, "result.txt")), false);
    const approval = (await container.approvals.list("pending"))[0]!,
      context = (await container.remoteApprovals!.get(scope, approval.id))!;
    const resolved = await command("approval.resolve", {
      approvalId: approval.id,
      clientRequestId: randomUUID(),
      approved: true,
      version: context.version,
      actionDigest: context.actionDigest,
    });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    await waitFor(
      async () => (await container.tasks.getRun(accepted.run.id))?.status === "succeeded",
    );
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "postgres verified");
    const detail = await command("task.read", { taskId: accepted.task.id });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).runs[0].status, "succeeded");
    const listed = await command("project.read", { kind: "tasks" });
    assert.equal((await listed.json()).tasks.length, 1);
    const approvals = await command("project.read", { kind: "approvals" });
    assert.equal((await approvals.json()).approvals.length, 1);
    const messages = await new PostgresMessages(db).list(accepted.task.conversationId);
    assert.equal(messages.length, 2);
    const events = await container.tasks.eventsAfter({
      taskId: accepted.task.id,
      after: 0,
      limit: 500,
    });
    assert.ok(events.some((event) => event.event.type === "tool_call"));
    assert.ok(events.some((event) => event.event.type === "file_change"));
    assert.ok(
      (await container.tasks.listArtifacts(accepted.task.id)).some(
        (artifact) => artifact.kind === "change",
      ),
    );
    assert.equal(
      (container.dbHandle.raw.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n,
      0,
    );
    const ready = await call("/health/ready");
    assert.deepEqual(await ready.json(), { status: "ok", database: "postgres" });
    await container.tasks.transition(accepted.task.id, "completed");
    await container.tasks.close(accepted.task.id);
    await db.query("UPDATE business_run_events SET created_at='2000-01-01' WHERE task_id=$1", [
      accepted.task.id,
    ]);
    const retention = new PostgresRetentionStore(db);
    const count = await retention.count(
      [accepted.task.id],
      [],
      new Date().toISOString(),
      new Date().toISOString(),
    );
    assert.ok(count.events > 0);
    await retention.prune(accepted.task.id, "", new Date().toISOString(), new Date().toISOString());
    await assert.rejects(
      container.tasks.eventsAfter({ taskId: accepted.task.id, after: 0, limit: 500 }),
      /回收/,
    );
  }, 30000);
  it("cancels an active approval wait on grant revocation and persists interruption across restart", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "cancelled.txt",
          content: "must not write",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const response = await command("task.create", {
      clientRequestId: randomUUID(),
      goal: "cancel",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: scope.workspaceId,
      requiresPlanApproval: false,
    });
    assert.equal(response.status, 201);
    const accepted = await response.json();
    await waitFor(async () => (await container.approvals.list("pending")).length > 0);
    assert.equal((await call("/grants/revoke", scope)).status, 200);
    await waitFor(
      async () => (await container.tasks.getRun(accepted.run.id))?.status === "cancelled",
    );
    assert.equal(existsSync(join(workspace, "cancelled.txt")), false);
    const service = new TaskSubmissionService(container.dbHandle, container.tasks);
    const interrupted = await service.submit({ goal: "interrupted on restart" });
    await store.runs.update(interrupted.run.id, { status: "running" });
    await store.tasks.update(interrupted.task.id, (value) => ({ ...value, status: "running" }));
    const restarted = new TaskService(container.dbHandle.db, new EventHub(), {
      persistence: store,
    });
    await restarted.ready;
    assert.equal((await restarted.getRun(interrupted.run.id))?.status, "failed");
    assert.equal((await restarted.get(interrupted.task.id))?.status, "failed");
    await restarted.shutdown();
  });
});

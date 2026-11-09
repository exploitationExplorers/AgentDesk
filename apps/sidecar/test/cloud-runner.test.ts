import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import {
  RemoteCapability,
  type RemoteActor,
  type RemoteCommand,
  type RemoteScope,
} from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { createCloudApp } from "../src/cloud-app";
import { loadCloudConfig, type CloudConfig } from "../src/cloud-config";
import { payloadDigest } from "../src/services/remote/digest";

let root: string;
let workspace: string;
let config: CloudConfig;
let container: Container;
let app: ReturnType<typeof createCloudApp>;
let faux: FauxProviderRegistration;
let scope: RemoteScope;
let actor: RemoteActor;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const call = (path: string, body?: unknown, method?: string) =>
  app.request(`/remote-api/v1${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "x-agentdesk-remote-token": config.remoteToken, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function envelope(
  action: RemoteCapability,
  payload: unknown,
  session = actor,
): { command: RemoteCommand; payload: unknown } {
  const requestId = (payload as { clientRequestId?: string }).clientRequestId ?? randomUUID();
  return {
    command: {
      ...scope,
      protocolVersion: 1,
      messageId: randomUUID(),
      requestId,
      actor: session,
      connectionEpoch: 1,
      action,
      payloadHash: payloadDigest(payload),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 25_000).toISOString(),
    },
    payload,
  };
}
const command = (action: RemoteCapability, payload: unknown, session = actor) =>
  call("/commands", envelope(action, payload, session));
async function waitFor(predicate: () => boolean, timeout = 8_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Runner condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function createTask(requiresPlanApproval = false) {
  const input = {
    clientRequestId: randomUUID(),
    goal: "Update the selected workspace",
    executor: "native-bot",
    workspaceMode: "existing",
    workspaceId: scope.workspaceId,
    requiresPlanApproval,
  };
  const response = await command("task.create", input);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { task: { id: string }; run: { id: string } };
}
async function resolveApproval(id: string, approved = true) {
  const context = container.remoteApprovals!.get(scope, id)!;
  return command("approval.resolve", {
    approvalId: id,
    clientRequestId: randomUUID(),
    approved,
    version: context.version,
    actionDigest: context.actionDigest,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-cloud-runner-"));
  const workspaceRoot = join(root, "workspaces");
  workspace = join(workspaceRoot, "example");
  mkdirSync(workspace, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.name", "Cloud Test");
  git("config", "user.email", "cloud@test.invalid");
  writeFileSync(join(workspace, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-m", "chore: initial");
  const masterFile = join(root, "master.key"),
    tokenFile = join(root, "remote.key");
  writeFileSync(masterFile, randomBytes(32).toString("base64"));
  writeFileSync(tokenFile, randomBytes(32).toString("hex"));
  config = loadCloudConfig({
    AGENTDESK_DATA_DIR: join(root, "data"),
    WORKSPACE_ROOT: workspaceRoot,
    AGENTDESK_MASTER_KEY_FILE: masterFile,
    REMOTE_SHARED_TOKEN_FILE: tokenFile,
    CLOUD_OWNER_USER_ID: "owner-1",
  });
  container = await createContainer(config, {
    inMemory: true,
    cloud: { hostId: config.hostId, workspaceRoot, taskTimeoutMs: 60_000 },
  });
  await container.cloudRunner!.registerConfiguredWorkspaces();
  const project = container.projects.list()[0]!;
  scope = {
    userId: config.ownerUserId,
    hostId: config.hostId,
    projectId: project.id,
    workspaceId: project.id,
  };
  actor = { userId: scope.userId, sessionId: "session-1", recentAuthAt: new Date().toISOString() };
  app = createCloudApp(container, config);
  const granted = await call(
    "/grants",
    {
      ...scope,
      capabilities: RemoteCapability.options,
      connectionEpoch: 1,
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
      revokedAt: null,
    },
    "PUT",
  );
  expect(granted.status, await granted.clone().text()).toBe(200);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
  ];
}, 20_000);
afterEach(async () => {
  if (container) {
    for (const task of container.tasks.list())
      if (task.currentRunId) container.tasks.requestCancel(task.currentRunId);
    await waitFor(() =>
      container.tasks
        .list()
        .every(
          (task) =>
            !task.currentRunId || container.tasks.getRun(task.currentRunId)?.status !== "running",
        ),
    );
    await container.dispose();
  }
  faux?.unregister();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Dedicated cloud runner", () => {
  it("ends SSE and rejects new requests while active tasks drain during shutdown", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "shutdown.txt",
          content: "must not write",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const { task, run } = await createTask();
    await waitFor(() => container.approvals.list("pending").length > 0);
    const stream = await call(
      `/tasks/${task.id}/events`,
      envelope("task.read", { taskId: task.id, after: 0 }),
    );
    expect(stream.status).toBe(200);
    const drained = stream.text();
    container.beginShutdown();
    expect((await call("/host")).status).toBe(503);
    await drained;
    await container.tasks.shutdown();
    expect(container.tasks.getRun(run.id)?.status).toBe("cancelled");
    expect(existsSync(join(workspace, "shutdown.txt"))).toBe(false);
  });
  it("requires a recently authenticated owner for Git credentials and rejects private repository URLs", async () => {
    const input = {
      url: "https://github.com/owner/repository.git",
      username: "owner",
      token: "fixture-token",
    };
    expect(
      (await call("/host/git-credentials", { actor: { ...actor, userId: "foreign-owner" }, input }))
        .status,
    ).toBe(401);
    expect(
      (
        await call("/host/git-credentials", {
          actor: { ...actor, recentAuthAt: "2020-01-01T00:00:00Z" },
          input,
        })
      ).status,
    ).toBe(401);
    const saved = await call("/host/git-credentials", { actor, input });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("fixture-token");
    expect(
      (
        await call("/host/repository-imports", {
          actor,
          input: {
            clientRequestId: randomUUID(),
            url: "http://127.0.0.1/private",
            name: "Owner",
            email: "owner@example.invalid",
          },
        })
      ).status,
    ).toBe(403);
    expect((await (await call("/host/repository-imports")).json()).imports).toEqual([]);
    expect(
      (
        await call("/host/repository-fetch", {
          actor: { ...actor, userId: "foreign-owner" },
          projectId: scope.projectId,
          ref: "refs/heads/test",
        })
      ).status,
    ).toBe(401);
    expect(
      (await call("/host/repository-fetch", { actor, projectId: scope.projectId, ref: "main" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/host/repository-fetch", {
          actor,
          projectId: "unknown",
          ref: "refs/heads/test",
        })
      ).status,
    ).toBe(404);
  });
  it("rejects local routes, missing credentials and foreign grants; exposes only explicit capabilities", async () => {
    expect((await app.request("/remote-api/v1/health")).status).toBe(401);
    expect((await app.request("/api/projects")).status).toBe(404);
    const health = await (await call("/health")).json();
    expect(health).toMatchObject({
      mode: "cloud",
      concurrency: 1,
      capabilities: expect.arrayContaining(["task.create", "git.commit"]),
    });
    expect(container.registry.list().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["deploy.run", "agents.delegate"]),
    );
    const grant = {
      ...scope,
      userId: "other-owner",
      capabilities: ["task.read"],
      connectionEpoch: 1,
      expiresAt: new Date(Date.now() + 40_000).toISOString(),
      revokedAt: null,
    };
    expect((await call("/grants", grant, "PUT")).status).toBe(403);
  });

  it("executes a real file write only after bound approval, ignoring a local allow rule", async () => {
    container.permissionRules.add("fs.write", "", "allow");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "result.txt",
          content: "verified",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("The file was written")),
    ]);
    const { task, run } = await createTask();
    await waitFor(() => container.approvals.list("pending").length > 0);
    expect(existsSync(join(workspace, "result.txt"))).toBe(false);
    const approval = container.approvals.list("pending")[0]!;
    expect(container.remoteApprovals!.get(scope, approval.id)).toMatchObject({ taskId: task.id });
    expect((await resolveApproval(approval.id)).status).toBe(200);
    await waitFor(() => container.tasks.getRun(run.id)?.status === "succeeded");
    expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("verified");
    const detail = await (
      await command("task.read", { taskId: task.id }, { ...actor, sessionId: "session-new" })
    ).json();
    expect(detail.runs[0].toolCalls[0]).toMatchObject({ name: "fs.write", isError: false });
  });

  it("enforces deny rules before approval and preserves the workspace", async () => {
    container.permissionRules.add("fs.write", "", "deny");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "denied.txt",
          content: "unsafe",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("The tool was denied")),
    ]);
    const { run } = await createTask();
    await waitFor(() => container.tasks.getRun(run.id)?.status === "succeeded");
    expect(existsSync(join(workspace, "denied.txt"))).toBe(false);
    expect(container.approvals.list("pending")).toHaveLength(0);
    expect(container.tasks.getRun(run.id)?.toolCalls?.[0]).toMatchObject({ isError: true });
  });

  it("rejects tools targeting another project or Git metadata", async () => {
    const otherWorkspace = join(config.workspaceRoot, "other");
    mkdirSync(otherWorkspace);
    execFileSync("git", ["init", "-b", "main"], { cwd: otherWorkspace, stdio: "ignore" });
    const otherProject = await container.projects.add(otherWorkspace);
    const gitConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    const attempts = [
      {
        project: otherProject.id,
        path: "outside.txt",
        content: "outside",
      },
      {
        project: scope.projectId,
        path: ".git/config",
        content: "unsafe",
      },
    ];

    for (const args of attempts) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(toWireName("fs.write"), { ...args, expectedHash: "" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxText("The write was rejected")),
      ]);
      const { run } = await createTask();
      await waitFor(() => container.tasks.getRun(run.id)?.status === "succeeded");
      expect(container.tasks.getRun(run.id)?.toolCalls?.[0]).toMatchObject({ isError: true });
      expect(container.approvals.list("pending")).toHaveLength(0);
    }

    expect(existsSync(join(workspace, "outside.txt"))).toBe(false);
    expect(existsSync(join(otherWorkspace, "outside.txt"))).toBe(false);
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(gitConfig);
  });

  it("forces shell approval and binds the approval to the normalized workspace", async () => {
    container.permissionRules.add("shell.run", "", "allow");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("shell.run"), {
          command: "pwd",
          cwd: scope.projectId,
          purpose: "Check the selected workspace",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("The command was not approved")),
    ]);
    const { task, run } = await createTask();
    await waitFor(() => container.approvals.list("pending").length > 0);
    const approval = container.approvals.list("pending")[0]!;
    expect(approval.kind).toBe("tool");
    expect(approval.detail).toContain(workspace);
    expect(container.remoteApprovals!.get(scope, approval.id)).toMatchObject({ taskId: task.id });
    expect((await resolveApproval(approval.id, false)).status).toBe(200);
    await waitFor(() => container.tasks.getRun(run.id)?.status === "succeeded");
  });

  it("cancels an active shell process when the grant is revoked", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("shell.run"), {
          command: `"${process.execPath}" -e "require('node:fs').writeFileSync('running.txt', JSON.stringify({ cwd: process.cwd(), pid: process.pid })); setInterval(() => {}, 1000)"`,
          cwd: scope.projectId,
          purpose: "Run a cancellable local process",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const { run } = await createTask();
    await waitFor(() => container.approvals.list("pending").length > 0);
    const approval = container.approvals.list("pending")[0]!;
    expect((await resolveApproval(approval.id)).status).toBe(200);
    await waitFor(() => existsSync(join(workspace, "running.txt")));
    const running = JSON.parse(readFileSync(join(workspace, "running.txt"), "utf8")) as {
      cwd: string;
      pid: number;
    };
    expect(running.cwd).toBe(workspace);

    container.remoteGrants!.revoke(scope);
    await waitFor(() => container.tasks.getRun(run.id)?.status === "cancelled");
    expect(() => process.kill(running.pid, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("requires the original session for lease renewal and cancels real approval waiting on revocation", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "late.txt",
          content: "late",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const { task, run } = await createTask();
    await waitFor(() => container.approvals.list("pending").length > 0);
    const payload = {
      taskId: task.id,
      leaseExpiresAt: new Date(Date.now() + 35_000).toISOString(),
    };
    expect(
      (
        await call(
          `/tasks/${task.id}/lease`,
          envelope("task.read", payload, { ...actor, sessionId: "forged-session" }),
        )
      ).status,
    ).toBe(403);
    const revoke = { taskId: task.id, leaseExpiresAt: new Date().toISOString() };
    expect((await call(`/tasks/${task.id}/lease`, envelope("task.read", revoke))).status).toBe(200);
    await waitFor(() => container.tasks.getRun(run.id)?.status === "cancelled");
    expect(existsSync(join(workspace, "late.txt"))).toBe(false);
  });

  it("replays more than 1000 durable events to a new session even after the execution lease expires", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
    const { task, run } = await createTask();
    await waitFor(() => container.tasks.getRun(run.id)?.status === "succeeded");
    for (let i = 0; i < 1005; i++)
      container.tasks.appendEvent({
        taskId: task.id,
        runId: run.id,
        event: { type: "text_delta", agent: "orchestrator", delta: String(i) },
      });
    container.dbHandle.raw
      .prepare("UPDATE remote_task_contexts SET lease_expires_at=? WHERE task_id=?")
      .run(new Date(0).toISOString(), task.id);
    const result = await call(
      `/tasks/${task.id}/events`,
      envelope("task.read", { taskId: task.id, after: 0 }, { ...actor, sessionId: "new-session" }),
    );
    expect(result.status).toBe(200);
    const stream = await result.text();
    expect(stream).toContain('"delta":"1004"');
    expect((stream.match(/^id:/gm) ?? []).length).toBeGreaterThan(1000);
  });

  it("connects Git status, preview, explicit approval and commit without exposing local routes", async () => {
    writeFileSync(join(workspace, "README.md"), "reviewed change\n");
    const status = await command("project.read", {
      kind: "git-status",
      clientRequestId: randomUUID(),
    });
    expect(status.status, await status.clone().text()).toBe(200);
    expect(await status.json()).toMatchObject({ files: [{ path: "README.md", kind: "modified" }] });
    const previewResponse = await command("git.preview", {
      clientRequestId: randomUUID(),
      kind: "commit",
      files: ["README.md"],
      message: "fix: reviewed change",
    });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200);
    const { operation } = await previewResponse.json();
    const preview = operation.result;
    expect((await resolveApproval(preview.approvalId)).status).toBe(200);
    const input = {
      clientRequestId: randomUUID(),
      previewId: preview.previewId,
      approvalId: preview.approvalId,
      version: preview.version,
      actionDigest: preview.actionDigest,
    };
    const committed = await command("git.commit", input);
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect(git("log", "-1", "--format=%s")).toBe("fix: reviewed change");
  }, 20_000);

  it("runs approved plans automatically and does not let followup bypass an unapproved plan", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "Create the result file",
          steps: ["Write approved.txt"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("Plan is ready")),
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), {
          project: scope.projectId,
          path: "approved.txt",
          content: "approved",
          expectedHash: "",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("Done")),
    ]);
    const { task } = await createTask(true);
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");
    const plan = container.approvals.list("pending").find((a) => a.kind === "plan")!;
    expect((await resolveApproval(plan.id)).status).toBe(200);
    await waitFor(() => container.approvals.list("pending").some((a) => a.kind === "tool"));
    expect(existsSync(join(workspace, "approved.txt"))).toBe(false);
    const write = container.approvals.list("pending").find((a) => a.kind === "tool")!;
    expect((await resolveApproval(write.id)).status).toBe(200);
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
    expect(readFileSync(join(workspace, "approved.txt"), "utf8")).toBe("approved");
    const review = container.approvals.list("pending").find((a) => a.kind === "review")!;
    expect((await resolveApproval(review.id)).status).toBe(200);
    expect(container.tasks.get(task.id)?.status).toBe("completed");
  });
});

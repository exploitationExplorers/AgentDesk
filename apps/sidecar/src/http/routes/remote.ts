import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  ProjectGrant,
  RemoteApprovalDecision,
  RemoteCommand,
  RemoteScope,
  RemoteTaskInput,
  CloudProviderInput,
  RemoteActor,
  RemoteId,
  type Approval,
  type RemoteCapability,
  type RemoteScope as RemoteScopeType,
} from "@agentdesk/shared";
import type { Container } from "../../container";
import type { CloudConfig } from "../../cloud-config";
import { RemoteOperationStore } from "../../services/remote/operations";
import { RemoteTaskSubmissionService } from "../../services/remote/task-submissions";
import { GitCredentialInput, RepositoryImportInput } from "../../services/remote/repository-setup";

const Envelope = z.strictObject({ command: RemoteCommand, payload: z.unknown() });
const TaskReadPayload = z.strictObject({ taskId: z.string().optional() });
const LookupPayload = z.strictObject({ action: z.string(), requestId: z.string() });
const OperationPayload = z.strictObject({ operationId: z.string() });
const LeasePayload = z.strictObject({ taskId: z.string(), leaseExpiresAt: z.iso.datetime() });
const EventsPayload = z.strictObject({
  taskId: z.string(),
  after: z.number().int().min(0).optional(),
});
const CancelPayload = z.strictObject({ taskId: z.string(), clientRequestId: z.string() });
const FollowupPayload = z.strictObject({
  taskId: z.string(),
  clientRequestId: z.string(),
  message: z.string().trim().min(1).max(32_000),
});

type Services = Container & { cloudConfig: CloudConfig };

function assertScope(command: RemoteCommand): RemoteScopeType {
  return RemoteScope.parse({
    userId: command.userId,
    hostId: command.hostId,
    projectId: command.projectId,
    workspaceId: command.workspaceId,
  });
}

function publicApproval(approval: Approval, context: unknown) {
  return { approval, context };
}

function taskIdsForScope(container: Container, scope: RemoteScopeType): string[] {
  return (
    container.dbHandle.raw
      .prepare(
        `SELECT task_id FROM remote_task_contexts WHERE user_id=? AND host_id=? AND project_id=? AND workspace_id=? ORDER BY rowid DESC`,
      )
      .all(scope.userId, scope.hostId, scope.projectId, scope.workspaceId) as Array<{
      task_id: string;
    }>
  ).map((row) => row.task_id);
}

function getTaskContextIds(container: Container, scope: RemoteScopeType): string[] {
  return (
    container.dbHandle.raw
      .prepare(
        `SELECT approval_id FROM remote_approval_contexts WHERE user_id=? AND host_id=? AND project_id=? AND workspace_id=? ORDER BY rowid DESC`,
      )
      .all(scope.userId, scope.hostId, scope.projectId, scope.workspaceId) as Array<{
      approval_id: string;
    }>
  ).map((row) => row.approval_id);
}

function scopedTask(container: Container, command: RemoteCommand, taskId: string) {
  const context = container.cloudRunner!.context(taskId);
  if (
    context.userId !== command.userId ||
    context.hostId !== command.hostId ||
    context.projectId !== command.projectId ||
    context.workspaceId !== command.workspaceId
  )
    throw new AppError(ErrorCode.NotFound, "Task not found");
  const task = container.tasks.get(taskId);
  if (!task) throw new AppError(ErrorCode.NotFound, "Task not found");
  return { task, context };
}

export function remoteRoutes(container: Services) {
  const app = new Hono();
  const runner = container.cloudRunner;
  const grants = container.remoteGrants;
  const remoteApprovals = container.remoteApprovals;
  if (!runner || !grants || !remoteApprovals) throw new Error("Cloud remote services are required");
  const operations = new RemoteOperationStore(container.dbHandle.raw);
  const transfers = container.workspaceTransfers!;
  const capabilities = [
    "project.read",
    "task.read",
    "task.create",
    "task.followup",
    "task.cancel",
    "approval.resolve",
    "provider.read",
    "provider.write",
    "provider.test",
    "git.preview",
    "git.commit",
    "git.push",
    "snapshot.create",
    "snapshot.read",
    ...(container.cloudConfig.kind === "office" ? [] : ["transfer.import"]),
  ];
  const executors = [
    { id: "native-bot", available: true },
    { id: "codex", available: false, reason: "Codex execution is not configured" },
  ];
  const authorize = (command: RemoteCommand, payload: unknown) => {
    if (command.userId !== container.cloudConfig.ownerUserId)
      throw new AppError(ErrorCode.Forbidden, "Resource owner does not match this runner");
    return runner.authorize(command, payload);
  };
  app.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json(new AppError(ErrorCode.BadRequest, "Remote request is too large").toBody(), 413),
    }),
  );

  const providerInput = (raw: unknown) => {
    if (
      raw &&
      typeof raw === "object" &&
      "apiKey" in raw &&
      !container.cloudConfig.allowServerProviderCredentials
    )
      throw new AppError(
        ErrorCode.Forbidden,
        "个人 API Key 请在本地配置。服务器凭证写入默认关闭。",
      );
    const input = CloudProviderInput.parse(raw);
    const endpoint = new URL(input.baseUrl);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !container.cloudConfig.allowedProviderHosts.includes(endpoint.hostname.toLowerCase())
    )
      throw new AppError(ErrorCode.Forbidden, "Provider endpoint is not allowed by cloud policy");
    return input;
  };
  const assertOwnerAuth = (actor: { userId: string; recentAuthAt: string }) => {
    const age = Date.now() - Date.parse(actor.recentAuthAt);
    if (actor.userId !== container.cloudConfig.ownerUserId || age > 15 * 60_000 || age < -5_000)
      throw new AppError(ErrorCode.Unauthorized, "Recent owner authentication is required");
  };

  app.use("*", async (c, next) => {
    if (container.shutdownSignal.aborted)
      return c.json(new AppError(ErrorCode.Conflict, "Runner is shutting down").toBody(), 503);
    const candidate = c.req.header("x-agentdesk-remote-token") ?? "";
    const expected = Buffer.from(container.cloudConfig.remoteToken);
    const actual = Buffer.from(candidate);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new AppError(ErrorCode.Unauthorized, "Invalid cloud runner token");
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > 256 * 1024)
      throw new AppError(ErrorCode.BadRequest, "Remote request is too large");
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      hostId: container.cloudConfig.hostId,
      mode: container.cloudConfig.kind ?? "cloud",
      concurrency: 1,
      capabilities,
      executors,
    }),
  );
  app.get("/host", async (c) =>
    c.json({
      id: container.cloudConfig.hostId,
      name: container.cloudConfig.name,
      kind: container.cloudConfig.kind ?? "cloud",
      capabilities,
      executors: [executors[0], await container.codex!.status()],
    }),
  );
  app.post("/host/executors/codex/login", async (c) => {
    const body = z.strictObject({ actor: RemoteActor }).parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(await container.codex!.login());
  });
  app.post("/host/executors/codex/login-status", async (c) => {
    const body = z.strictObject({ actor: RemoteActor }).parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(await container.codex!.status());
  });
  app.get("/host/projects", async (c) =>
    c.json({
      hostId: container.cloudConfig.hostId,
      projects: (
        await Promise.all(
          container.projects.list().map(async (project) => {
            try {
              await runner.resolveWorkspace({
                userId: container.cloudConfig.ownerUserId,
                hostId: container.cloudConfig.hostId,
                projectId: project.id,
                workspaceId: project.id,
              });
              return project;
            } catch {
              return null;
            }
          }),
        )
      )
        .filter((project) => project !== null)
        .map((project) => ({
          id: project.id,
          name: project.name,
          workspaceId: project.id,
          workspaceMode: "existing",
        })),
    }),
  );
  app.get("/host/providers", (c) =>
    c.json({
      providers: container.providers.list(),
      bindings: container.providers.listBindings(),
      credentialPolicy: {
        allowServerCredentials: container.cloudConfig.allowServerProviderCredentials === true,
        personalKeys: "local-only",
        storage: "server",
      },
    }),
  );
  const setup = () => {
    if (!container.cloudRepositorySetup)
      throw new AppError(ErrorCode.Forbidden, "仅云端实例支持创建仓库");
    return container.cloudRepositorySetup;
  };
  app.get("/host/repository-imports", (c) => c.json({ imports: setup().list() }));
  app.get("/host/repository-imports/:id", (c) => c.json(setup().get(c.req.param("id"))));
  app.post("/host/repository-imports", async (c) => {
    const body = z
      .strictObject({ actor: RemoteActor, input: RepositoryImportInput })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(setup().begin(body.input), 202);
  });
  app.post("/host/git-credentials", async (c) => {
    const body = z
      .strictObject({ actor: RemoteActor, input: GitCredentialInput })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(setup().credentials(body.input));
  });
  app.post("/host/git-credentials/test", async (c) => {
    const body = z
      .strictObject({ actor: RemoteActor, url: z.string().max(2048) })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(await setup().test(body.url));
  });
  app.post("/host/repository-fetch", async (c) => {
    const body = z
      .strictObject({
        actor: RemoteActor,
        projectId: RemoteId,
        ref: z.string().startsWith("refs/heads/").max(1024),
      })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    const service = setup();
    const workspace = await runner.resolveWorkspace({
      userId: body.actor.userId,
      hostId: container.cloudConfig.hostId,
      projectId: body.projectId,
      workspaceId: body.projectId,
    });
    return c.json(
      await runner.locks.withLock(workspace, `fetch-${Date.now()}`, () =>
        service.fetchBase(workspace, body.ref),
      ),
    );
  });
  app.put("/host/providers", async (c) => {
    const body = z
      .strictObject({
        actor: RemoteActor,
        id: z.string().optional(),
        input: z.unknown(),
        bindings: z.unknown().optional(),
      })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    const input = providerInput(body.input);
    const provider = body.id
      ? container.providers.update(body.id, input)
      : container.providers.create(input);
    const bindings =
      body.bindings === undefined
        ? container.providers.listBindings()
        : container.providers.setBindings(body.bindings);
    return c.json({ provider, bindings });
  });
  app.put("/host/providers/:id", async (c) => {
    const body = z
      .strictObject({
        actor: RemoteActor,
        input: z.unknown(),
      })
      .parse(await c.req.json());
    assertOwnerAuth(body.actor);
    const input = providerInput(body.input);
    return c.json(
      c.req.param("id") === "new"
        ? container.providers.create(input)
        : container.providers.update(RemoteId.parse(c.req.param("id")), input),
    );
  });
  app.post("/host/providers/:id/test", async (c) => {
    const body = z.strictObject({ actor: RemoteActor }).parse(await c.req.json());
    assertOwnerAuth(body.actor);
    return c.json(await container.providers.test(c.req.param("id")));
  });

  app.put("/grants", async (c) => {
    const grant = ProjectGrant.parse(await c.req.json());
    if (
      grant.userId !== container.cloudConfig.ownerUserId ||
      Date.parse(grant.expiresAt) > Date.now() + 45_000 ||
      Date.parse(grant.expiresAt) <= Date.now()
    )
      throw new AppError(ErrorCode.Forbidden, "Invalid cloud grant owner or lifetime");
    await runner.resolveWorkspace(grant);
    grants.put(grant);
    return c.json({ ok: true });
  });
  app.post("/grants/revoke", async (c) => {
    const scope = RemoteScope.parse(await c.req.json());
    if (
      scope.userId !== container.cloudConfig.ownerUserId ||
      scope.hostId !== container.cloudConfig.hostId
    )
      throw new AppError(ErrorCode.Forbidden, "Grant owner mismatch");
    grants.revoke(scope);
    for (const taskId of taskIdsForScope(container, scope)) {
      const task = container.tasks.get(taskId);
      if (task?.currentRunId) container.tasks.requestCancel(task.currentRunId);
    }
    return c.json({ ok: true });
  });

  app.post("/operations/lookup", async (c) => {
    const { command, payload } = Envelope.parse(await c.req.json());
    authorize(command, payload);
    if (command.action !== "task.read")
      throw new AppError(ErrorCode.Forbidden, "task.read is required");
    const body = LookupPayload.parse(payload);
    return c.json({
      operation:
        operations.getByRequest(
          assertScope(command),
          body.action as RemoteCapability,
          body.requestId,
        ) ?? null,
    });
  });
  app.post("/operations/:id", async (c) => {
    const { command, payload } = Envelope.parse(await c.req.json());
    authorize(command, payload);
    if (command.action !== "task.read")
      throw new AppError(ErrorCode.Forbidden, "task.read is required");
    const body = OperationPayload.parse(payload);
    if (body.operationId !== c.req.param("id"))
      throw new AppError(ErrorCode.BadRequest, "Operation ID mismatch");
    return c.json({ operation: operations.get(assertScope(command), body.operationId) ?? null });
  });

  app.post("/tasks/:id/lease", async (c) => {
    const { command, payload } = Envelope.parse(await c.req.json());
    authorize(command, payload);
    if (command.action !== "task.read")
      throw new AppError(ErrorCode.Forbidden, "task.read is required");
    const body = LeasePayload.parse(payload);
    if (body.taskId !== c.req.param("id"))
      throw new AppError(ErrorCode.BadRequest, "Task ID mismatch");
    return c.json({ context: runner.renewLease(command, body) });
  });

  app.post("/tasks/:id/events", async (c) => {
    const { command, payload } = Envelope.parse(await c.req.json());
    const body = EventsPayload.parse(payload);
    if (command.action !== "task.read" || body.taskId !== c.req.param("id"))
      throw new AppError(ErrorCode.Forbidden, "Task event scope mismatch");
    const scope = assertScope(authorize(command, payload));
    runner.assertReadAccess(scope, body.taskId, command.connectionEpoch);
    const after = body.after ?? 0;
    return streamSSE(c, async (stream) => {
      const release = container.tasks.pinEventHistory({ taskId: body.taskId });
      try {
        const expired = container.tasks.expiredHistory({ taskId: body.taskId }, after);
        if (expired) {
          await stream.writeSSE({ event: "history_expired", data: JSON.stringify(expired) });
          return;
        }
        let last = after;
        let closed = false;
        let wake: (() => void) | undefined;
        const unsubscribe = container.hub.subscribe(`task:${body.taskId}`, () => wake?.());
        const heartbeat = setInterval(() => wake?.(), 5_000);
        const close = () => {
          closed = true;
          wake?.();
        };
        stream.onAbort(close);
        container.shutdownSignal.addEventListener("abort", close, { once: true });
        if (container.shutdownSignal.aborted) close();
        try {
          while (!closed) {
            runner.assertReadAccess(scope, body.taskId, command.connectionEpoch);
            const page = container.tasks.eventsAfter({
              taskId: body.taskId,
              after: last,
              limit: 100,
            });
            for (const event of page) {
              if (closed) return;
              runner.assertReadAccess(scope, body.taskId, command.connectionEpoch);
              await stream.writeSSE({
                id: String(event.seq),
                event: "task",
                data: JSON.stringify(event),
              });
              last = event.seq;
            }
            if (page.length === 100) continue;
            const task = container.tasks.get(body.taskId);
            const currentRun = task?.currentRunId
              ? container.tasks.getRun(task.currentRunId)
              : undefined;
            if (
              !task ||
              ["completed", "failed", "cancelled", "closed"].includes(task.status) ||
              (currentRun && ["succeeded", "failed", "cancelled"].includes(currentRun.status))
            )
              break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            if (!closed) await stream.writeSSE({ event: "keepalive", data: "" });
          }
        } catch (error) {
          if (!closed && error instanceof AppError)
            await stream.writeSSE({ event: "error", data: JSON.stringify(error.toBody()) });
        } finally {
          container.shutdownSignal.removeEventListener("abort", close);
          clearInterval(heartbeat);
          unsubscribe();
        }
      } finally {
        release();
      }
    });
  });

  app.post("/commands", async (c) => {
    const { command, payload } = Envelope.parse(await c.req.json());
    authorize(command, payload);
    const scope = assertScope(command);
    switch (command.action) {
      case "snapshot.create": {
        if ((payload as { clientRequestId?: string })?.clientRequestId !== command.requestId)
          throw new AppError(ErrorCode.BadRequest, "Snapshot request identity mismatch");
        return c.json(await transfers.capture(scope, payload), 201);
      }
      case "snapshot.read": {
        const body = payload as { kind?: string; snapshotId?: string; transferId?: string };
        if (body.kind === "chunk") return c.json(await transfers.chunk(scope, payload));
        if (body.kind === "transfer" && body.transferId)
          return c.json(transfers.transfer(scope, body.transferId));
        if (body.kind === "describe" && body.snapshotId)
          return c.json(transfers.describe(scope, body.snapshotId));
        throw new AppError(ErrorCode.BadRequest, "Unknown snapshot query");
      }
      case "transfer.import": {
        if (container.cloudConfig.kind === "office")
          throw new AppError(
            ErrorCode.Forbidden,
            "Transfers may only import into cloud workspaces",
          );
        const kind = (payload as { kind?: string })?.kind;
        if (kind === "begin") return c.json(await transfers.begin(scope, payload), 201);
        if (kind === "upload") return c.json(await transfers.upload(scope, payload));
        if (kind === "import") return c.json(await transfers.import(scope, payload));
        throw new AppError(ErrorCode.BadRequest, "Unknown transfer operation");
      }
      case "project.read": {
        const project = container.projects.get(scope.projectId);
        await runner.resolveWorkspace(scope);
        if (payload === undefined || payload === null || typeof payload !== "object")
          throw new AppError(ErrorCode.BadRequest, "Invalid project.read payload");
        if ((payload as { kind?: string }).kind === "status")
          return c.json({
            project: { id: project.id, name: project.name },
            status: await container.projects.status(project.id),
          });
        if ((payload as { kind?: string }).kind === "git-status") {
          const body = z
            .strictObject({ kind: z.literal("git-status"), clientRequestId: z.string() })
            .parse(payload);
          if (command.requestId !== body.clientRequestId)
            throw new AppError(ErrorCode.Forbidden, "Git status request identity does not match");
          const repositoryOperations = container.repositoryOperations;
          if (!repositoryOperations)
            throw new AppError(ErrorCode.ServiceUnavailable, "Repository status is unavailable");
          return c.json(await repositoryOperations.status(command, body));
        }
        if ((payload as { kind?: string }).kind === "tasks")
          return c.json({
            tasks: taskIdsForScope(container, scope)
              .map((id) => container.tasks.get(id))
              .filter(Boolean),
          });
        if ((payload as { kind?: string }).kind === "approvals") {
          const approvals = getTaskContextIds(container, scope)
            .map((id) => ({
              approval: container.approvals.get(id),
              context: remoteApprovals.get(scope, id),
            }))
            .filter((row) => row.approval && row.context);
          return c.json({
            approvals: approvals.map((row) => publicApproval(row.approval!, row.context)),
          });
        }
        if ((payload as { kind?: string }).kind === "approval") {
          const body = z
            .strictObject({ kind: z.literal("approval"), approvalId: RemoteId })
            .parse(payload);
          const context = remoteApprovals.get(scope, body.approvalId);
          const approval = context ? container.approvals.get(body.approvalId) : undefined;
          if (!context || !approval) throw new AppError(ErrorCode.NotFound, "Approval not found");
          return c.json(publicApproval(approval, context));
        }
        throw new AppError(ErrorCode.BadRequest, "Unsupported project.read query");
      }
      case "task.read": {
        if (
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          "requestId" in payload
        ) {
          const body = LookupPayload.parse(payload);
          return c.json({
            operation:
              operations.getByRequest(scope, body.action as RemoteCapability, body.requestId) ??
              null,
          });
        }
        const body = TaskReadPayload.parse(payload);
        if (!body.taskId) {
          return c.json({
            tasks: taskIdsForScope(container, scope)
              .map((id) => container.tasks.get(id))
              .filter(Boolean),
          });
        }
        const { task, context } = scopedTask(container, command, body.taskId);
        const approvals = getTaskContextIds(container, scope)
          .map((id) => ({
            approval: container.approvals.get(id),
            context: remoteApprovals.get(scope, id),
          }))
          .filter((item) => item.context?.taskId === task.id && item.approval);
        return c.json({
          task,
          context,
          runs: container.tasks.listRuns(task.id),
          approvals: approvals.map((row) => publicApproval(row.approval!, row.context)),
        });
      }
      case "task.create": {
        const input = RemoteTaskInput.parse(payload);
        if (input.clientRequestId !== command.requestId)
          throw new AppError(ErrorCode.BadRequest, "Request ID mismatch");
        const service = new RemoteTaskSubmissionService(
          container.dbHandle,
          container.tasks,
          grants,
          (s) => runner.resolveWorkspace(s),
          async () => Boolean((await container.codex!.status()).available),
        );
        const accepted = await service.submit(command, input);
        if (accepted.run.status === "queued") container.tasks.enqueue(accepted.run.id);
        return c.json(
          {
            operation: accepted.operation,
            replayed: accepted.replayed,
            task: accepted.task,
            run: accepted.run,
          },
          accepted.replayed ? 200 : 201,
        );
      }
      case "task.followup": {
        const body = FollowupPayload.parse(payload);
        if (body.clientRequestId !== command.requestId)
          throw new AppError(ErrorCode.BadRequest, "Request ID mismatch");
        const { task, context } = scopedTask(container, command, body.taskId);
        const workspace = await runner.resolveWorkspace(scope);
        authorize(command, payload);
        const accepted = operations.accept(
          scope,
          "task.followup",
          body.clientRequestId,
          body,
          (operationId) => {
            const run = container.tasks.createRun({
              taskId: task.id,
              kind: "root",
              agent: task.agent ?? "orchestrator",
              trigger: "followup",
              idempotencyKey: body.clientRequestId,
              input: { userMessage: body.message, workspace },
            });
            const leaseExpiresAt = new Date(
              Math.min(Date.now() + 45_000, Date.parse(grants.get(scope)!.expiresAt)),
            ).toISOString();
            container.dbHandle.raw
              .prepare(
                `UPDATE remote_task_contexts SET session_id=?,recent_auth_at=?,lease_expires_at=?,connection_epoch=? WHERE task_id=? AND session_id=?`,
              )
              .run(
                command.actor.sessionId,
                command.actor.recentAuthAt,
                leaseExpiresAt,
                command.connectionEpoch,
                task.id,
                context.actor.sessionId,
              );
            for (const id of getTaskContextIds(container, scope)) {
              const approval = container.approvals.get(id);
              if (
                remoteApprovals.get(scope, id)?.taskId === task.id &&
                approval?.status === "pending"
              )
                container.approvals.resolve(id, false, "expired");
            }
            return { taskId: task.id, runId: run.id, followupOperationId: operationId };
          },
        );
        const result = accepted.operation.result as { runId?: string } | null;
        const run = result?.runId ? container.tasks.getRun(result.runId) : undefined;
        if (!run) throw new AppError(ErrorCode.Conflict, "Followup run could not be recovered");
        if (run.status === "queued") container.tasks.enqueue(run.id);
        return c.json({
          operation: accepted.operation,
          replayed: accepted.replayed,
          task: container.tasks.get(task.id),
          run,
        });
      }
      case "task.cancel": {
        const body = CancelPayload.parse(payload);
        if (body.clientRequestId !== command.requestId)
          throw new AppError(ErrorCode.BadRequest, "Request ID mismatch");
        const { task } = scopedTask(container, command, body.taskId);
        const accepted = operations.accept(
          scope,
          "task.cancel",
          body.clientRequestId,
          body,
          () => ({ taskId: task.id, runId: task.currentRunId }),
        );
        const runId = (accepted.operation.result as { runId?: string } | null)?.runId;
        const run = runId
          ? accepted.replayed
            ? container.tasks.getRun(runId)
            : container.tasks.requestCancel(runId)
          : undefined;
        return c.json({
          operation: accepted.operation,
          replayed: accepted.replayed,
          task,
          run: run ?? null,
          cancelRequested: run?.cancelRequested ?? false,
        });
      }
      case "approval.resolve": {
        const body = z
          .strictObject({ approvalId: z.string(), ...RemoteApprovalDecision.shape })
          .parse(payload);
        if (body.clientRequestId !== command.requestId)
          throw new AppError(ErrorCode.BadRequest, "Request ID mismatch");
        const { approvalId, ...decision } = body;
        const approvalContext = remoteApprovals.get(scope, approvalId);
        if (!approvalContext) throw new AppError(ErrorCode.NotFound, "Approval not found");
        if (approvalContext.taskId && approvalContext.decision === null)
          runner.assertLease(scope, approvalContext.taskId, command.actor.sessionId);
        const resolved = remoteApprovals.resolve(scope, approvalContext.approvalId, decision);
        const approval = resolved.approval;
        if (
          approval.kind === "plan" &&
          approvalContext.taskId &&
          decision.approved &&
          approvalContext.decision === null
        ) {
          await Promise.resolve();
          const task = container.tasks.get(approvalContext.taskId)!;
          const workspace = await runner.resolveWorkspace(scope);
          authorize(command, payload);
          const run = container.tasks.createRun({
            taskId: task.id,
            kind: "root",
            agent: task.agent ?? "orchestrator",
            trigger: "resume",
            idempotencyKey: `plan:${approval.id}`,
            input: {
              userMessage: "Execute the approved plan and report the actual changes and checks.",
              workspace,
            },
          });
          container.tasks.enqueue(run.id);
        }
        if (approval.kind === "review" && approvalContext.taskId) {
          const task = container.tasks.get(approvalContext.taskId);
          if (task?.status === "awaiting_review")
            container.tasks.transition(task.id, decision.approved ? "completed" : "failed");
        }
        return c.json({ approval, context: resolved.context });
      }
      case "git.preview":
        if (!container.repositoryOperations)
          throw new AppError(ErrorCode.ServiceUnavailable, "Repository operations unavailable");
        return c.json(await container.repositoryOperations.preview(command, payload));
      case "git.commit":
        if (!container.repositoryOperations)
          throw new AppError(ErrorCode.ServiceUnavailable, "Repository operations unavailable");
        return c.json(await container.repositoryOperations.commit(command, payload));
      case "git.push":
        if (!container.repositoryOperations)
          throw new AppError(ErrorCode.ServiceUnavailable, "Repository operations unavailable");
        return c.json(await container.repositoryOperations.push(command, payload));
      default:
        throw new AppError(ErrorCode.Forbidden, "Capability is not available on the cloud runner");
    }
  });

  return app;
}

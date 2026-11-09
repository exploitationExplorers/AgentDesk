import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import {
  AppError,
  ErrorCode,
  RemoteApprovalContext,
  type Approval,
  type RemoteCommand,
  type RemoteScope,
  type RemoteTaskContext,
  type Run,
  type Task,
} from "@agentdesk/shared";
import { ToolRegistry, type AnyAgentTool } from "@agentdesk/agent-core";
import type { ProjectService } from "../projects";
import type { ApprovalService } from "../approvals";
import type { TaskService } from "../tasks";
import type { RemoteGrantStore } from "./grants";
import { payloadDigest } from "./digest";
import { readRemoteTask } from "./task-contexts";
import { RemoteApprovalService } from "./approvals";
import { RepositoryLockManager } from "./repository-locks";
import type { PermissionRuleService } from "../permission-rules";

const activeRun = new AsyncLocalStorage<{ taskId: string; runId: string }>();
const LEASE_MS = 45_000;

export class CloudRunnerService {
  readonly locks = new RepositoryLockManager();

  constructor(
    private readonly raw: Database.Database,
    readonly hostId: string,
    readonly workspaceRoot: string,
    private readonly taskTimeoutMs: number,
    private readonly projects: ProjectService,
    private readonly grants: RemoteGrantStore,
    private readonly approvals: ApprovalService,
    private readonly tasks: () => TaskService,
    private readonly permissionRules: PermissionRuleService,
    private readonly officeProjects?: Readonly<Record<string, string>>,
  ) {}

  async resolveWorkspace(scope: RemoteScope): Promise<string> {
    if (scope.hostId !== this.hostId || scope.workspaceId !== scope.projectId)
      throw new AppError(ErrorCode.Forbidden, "Workspace scope does not match the cloud project");
    const project = this.projects.get(scope.projectId);
    const workspace = await realpath(project.path);
    if (this.officeProjects) {
      if (this.officeProjects[scope.projectId] !== workspace)
        throw new AppError(
          ErrorCode.Forbidden,
          "Project is not in the locally confirmed device allowlist",
        );
      return workspace;
    }
    const root = await realpath(this.workspaceRoot);
    const rel = relative(root, workspace);
    if (
      !rel ||
      rel === "." ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      resolve(root, rel) !== workspace
    )
      throw new AppError(ErrorCode.Forbidden, "Workspace is outside the configured root");
    if (!(await stat(workspace)).isDirectory())
      throw new AppError(ErrorCode.NotFound, "Workspace is unavailable");
    return workspace;
  }

  async registerConfiguredWorkspaces(): Promise<void> {
    if (this.officeProjects) return;
    const root = await realpath(this.workspaceRoot);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = await realpath(resolve(root, entry.name));
      const rel = relative(root, candidate);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== candidate)
        continue;
      try {
        const gitStat = await stat(resolve(candidate, ".git"));
        if (!gitStat.isDirectory() && !gitStat.isFile()) continue;
      } catch {
        continue;
      }
      await this.projects.add(candidate);
    }
  }

  authorize(command: RemoteCommand, payload: unknown) {
    const authorized = this.grants.authorize(command, payload);
    if (authorized.hostId !== this.hostId)
      throw new AppError(ErrorCode.Forbidden, "Cloud host mismatch");
    return authorized;
  }

  context(taskId: string): RemoteTaskContext {
    const context = readRemoteTask(this.raw, taskId);
    if (!context) throw new AppError(ErrorCode.NotFound, "Remote task not found");
    return context;
  }

  taskContext(command: RemoteCommand, payload: unknown, taskId: string, requireSession = true) {
    const authorized = this.authorize(command, payload);
    const context = this.context(taskId);
    if (
      context.userId !== authorized.userId ||
      context.hostId !== authorized.hostId ||
      context.projectId !== authorized.projectId ||
      context.workspaceId !== authorized.workspaceId ||
      context.connectionEpoch !== authorized.connectionEpoch ||
      (requireSession && context.actor.sessionId !== authorized.actor.sessionId)
    )
      throw new AppError(ErrorCode.Forbidden, "Task ownership or session does not match");
    if (Date.parse(context.leaseExpiresAt) <= Date.now())
      throw new AppError(ErrorCode.Forbidden, "Task lease expired");
    return context;
  }

  assertLease(scope: RemoteScope, taskId: string, sessionId?: string): RemoteTaskContext {
    const context = this.context(taskId);
    const grant = this.grants.get(scope);
    if (
      context.userId !== scope.userId ||
      context.hostId !== scope.hostId ||
      context.projectId !== scope.projectId ||
      context.workspaceId !== scope.workspaceId ||
      (sessionId !== undefined && context.actor.sessionId !== sessionId) ||
      !grant ||
      grant.revokedAt ||
      grant.connectionEpoch !== context.connectionEpoch ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      Date.parse(context.leaseExpiresAt) <= Date.now()
    )
      throw new AppError(ErrorCode.Forbidden, "Remote task lease or grant is no longer active");
    return context;
  }

  assertReadAccess(scope: RemoteScope, taskId: string, epoch: number): RemoteTaskContext {
    const context = this.context(taskId);
    const grant = this.grants.get(scope);
    if (
      context.userId !== scope.userId ||
      context.hostId !== scope.hostId ||
      context.projectId !== scope.projectId ||
      context.workspaceId !== scope.workspaceId ||
      !grant ||
      grant.revokedAt ||
      grant.connectionEpoch !== epoch ||
      !grant.capabilities.includes("task.read") ||
      Date.parse(grant.expiresAt) <= Date.now()
    )
      throw new AppError(ErrorCode.Forbidden, "Task read authorization is no longer active");
    return context;
  }

  authorizeRun(run: Run): void {
    const context = this.context(run.taskId);
    const grant = this.grants.get(context);
    if (
      !grant ||
      grant.revokedAt ||
      grant.connectionEpoch !== context.connectionEpoch ||
      !grant.capabilities.includes("task.create") ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      Date.parse(context.leaseExpiresAt) <= Date.now()
    )
      throw new AppError(ErrorCode.Forbidden, "Remote task lease or grant is no longer active");
  }

  async withRun<T>(
    run: Run,
    task: Task,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.authorizeRun(run);
    const context = this.context(task.id);
    const workspace = await this.resolveWorkspace(context);
    signal.throwIfAborted();
    const leaseController = new AbortController();
    const executionSignal = AbortSignal.any([
      signal,
      leaseController.signal,
      AbortSignal.timeout(this.taskTimeoutMs),
    ]);
    const checkLease = setInterval(() => {
      try {
        this.authorizeRun(run);
      } catch {
        leaseController.abort(new Error("Remote authorization expired"));
      }
    }, 1000);
    checkLease.unref();
    try {
      return await this.locks.withLock(workspace, run.id, () =>
        activeRun.run({ taskId: task.id, runId: run.id }, async () => {
          this.authorizeRun(run);
          return action(executionSignal);
        }),
      );
    } finally {
      clearInterval(checkLease);
    }
  }

  assertActiveRun(): {
    taskId: string;
    runId: string;
    context: RemoteTaskContext;
    workspace: string;
  } {
    const active = activeRun.getStore();
    if (!active) throw new AppError(ErrorCode.Forbidden, "Tool is outside an authorized cloud run");
    const context = this.context(active.taskId);
    const grant = this.grants.get(context);
    if (
      !grant ||
      grant.revokedAt ||
      grant.connectionEpoch !== context.connectionEpoch ||
      !grant.capabilities.includes("task.create") ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      Date.parse(context.leaseExpiresAt) <= Date.now()
    )
      throw new AppError(ErrorCode.Forbidden, "Remote task lease or grant is no longer active");
    const project = this.projects.get(context.projectId);
    const workspace = realpathSync(project.path);
    if (this.officeProjects) {
      if (this.officeProjects[context.projectId] !== workspace)
        throw new AppError(
          ErrorCode.Forbidden,
          "Project is not in the locally confirmed device allowlist",
        );
      return { ...active, context, workspace };
    }
    const root = realpathSync(this.workspaceRoot);
    const rel = relative(root, workspace);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== workspace)
      throw new AppError(ErrorCode.Forbidden, "Workspace is outside the configured root");
    return { ...active, context, workspace };
  }

  bindApproval(approval: Approval, task: Task): void {
    const context = this.context(task.id);
    const digest = payloadDigest({
      kind: approval.kind,
      title: approval.title,
      detail: approval.detail,
      payload: approval.payload,
    });
    new RemoteApprovalService(this.raw, this.approvals).attach(
      RemoteApprovalContext.parse({
        approvalId: approval.id,
        userId: context.userId,
        hostId: context.hostId,
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        operationId: context.operationId,
        taskId: task.id,
        action: "approval.resolve",
        actionDigest: digest,
        version: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        resolvedBy: null,
        decision: null,
      }),
    );
  }

  requiresPlan(task: Task): boolean {
    if (!task.requiresPlanApproval) return false;
    const plan = this.tasks().latestArtifact(task.id, "plan");
    if (!plan) return true;
    const ids = this.raw
      .prepare("SELECT approval_id FROM remote_approval_contexts WHERE task_id=? AND decision=1")
      .all(task.id) as Array<{ approval_id: string }>;
    return !ids.some(({ approval_id }) => {
      const approval = this.approvals.get(approval_id);
      const payload = approval?.payload as { artifactId?: string } | undefined;
      return (
        approval?.kind === "plan" &&
        approval.status === "approved" &&
        payload?.artifactId === plan.id
      );
    });
  }

  renewLease(
    command: RemoteCommand,
    payload: { taskId: string; leaseExpiresAt: string },
  ): RemoteTaskContext {
    const current = this.taskContext(command, payload, payload.taskId);
    const grant = this.grants.get(current);
    const expiry = Date.parse(payload.leaseExpiresAt);
    const now = Date.now();
    if (!grant || expiry > now + LEASE_MS || expiry > Date.parse(grant.expiresAt))
      throw new AppError(ErrorCode.BadRequest, "Lease duration exceeds the grant limit");
    const updated = this.raw
      .transaction(() => {
        const taskUpdate = this.raw
          .prepare(
            `UPDATE remote_task_contexts SET lease_expires_at=? WHERE task_id=? AND session_id=? AND connection_epoch=?`,
          )
          .run(
            payload.leaseExpiresAt,
            payload.taskId,
            command.actor.sessionId,
            command.connectionEpoch,
          );
        return taskUpdate;
      })
      .immediate();
    if (updated.changes !== 1)
      throw new AppError(ErrorCode.Conflict, "Task lease changed concurrently");
    if (expiry <= now) {
      const task = this.tasks().get(payload.taskId);
      if (task?.currentRunId) this.tasks().requestCancel(task.currentRunId);
    }
    return this.context(payload.taskId);
  }

  restrictedRegistry(source: ToolRegistry): ToolRegistry {
    const target = new ToolRegistry();
    const allowed = [
      "projects.status",
      "fs.read",
      "fs.write",
      "fs.patch",
      "fs.glob",
      "fs.search",
      "shell.run",
      "tasks.submit_plan",
    ];
    for (const name of allowed) {
      const tool = source.get(name);
      if (!tool) continue;
      target.register(this.restrictTool(tool, name));
    }
    return target;
  }

  private restrictTool(tool: AnyAgentTool, name: string): AnyAgentTool {
    const requireProject = (args: unknown) => {
      const { context, workspace } = this.assertActiveRun();
      if (this.permissionRules.match(name, args)?.decision === "deny")
        throw new AppError(ErrorCode.Forbidden, "Tool is denied by the host permission policy");
      if (typeof args === "object" && args !== null && "project" in args) {
        const project = (args as { project?: unknown }).project;
        if (typeof project !== "string" || this.projects.find(project).id !== context.projectId)
          throw new AppError(ErrorCode.Forbidden, "Tool project does not match the task workspace");
      }
      if (typeof args === "object" && args !== null) {
        const values = args as { cwd?: unknown; path?: unknown };
        if (
          name === "shell.run" &&
          values.cwd !== undefined &&
          values.cwd !== workspace &&
          values.cwd !== context.projectId
        )
          throw new AppError(
            ErrorCode.Forbidden,
            "Shell directory does not match the task workspace",
          );
        if (
          name.startsWith("fs.") &&
          typeof values.path === "string" &&
          values.path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")
        )
          throw new AppError(
            ErrorCode.Forbidden,
            "Git metadata must be changed through repository operations",
          );
      }
      return { context, workspace };
    };
    const original = tool;
    const risk = name === "shell.run" ? "confirm" : tool.risk;
    return {
      ...tool,
      risk,
      riskFor: name === "shell.run" ? () => "confirm" : tool.riskFor,
      describeApproval: async (args) => {
        const { workspace } = requireProject(args);
        const normalized =
          name === "shell.run" && typeof args === "object" && args !== null
            ? { ...args, cwd: workspace }
            : args;
        return tool.describeApproval
          ? tool.describeApproval(normalized)
          : { title: `Execute ${name}`, detail: JSON.stringify(normalized) };
      },
      execute: async (args, ctx) => {
        const { context, workspace } = requireProject(args);
        let safeArgs = args;
        if (typeof args === "object" && args !== null && "project" in args)
          safeArgs = { ...args, project: context.projectId };
        if (name === "shell.run" && typeof safeArgs === "object" && safeArgs !== null)
          safeArgs = { ...safeArgs, cwd: workspace };
        return original.execute(safeArgs, ctx);
      },
    } as AnyAgentTool;
  }
}

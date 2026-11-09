import {
  AppError,
  ErrorCode,
  RemoteId,
  RemoteTaskInput,
  type RemoteActor,
  type RemoteScope,
} from "@agentdesk/shared";
import { commandDigest } from "./client";
import type { RunnerClient } from "./client";
import type { RemoteRoutingStore } from "./store";
import type { RemoteSubmission } from "./store";

export interface CloudProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceMode?: string;
}
export interface TaskSnapshot {
  task: { id: string; status: string; [key: string]: unknown };
  runs?: Array<Record<string, unknown>>;
  approvals?: ApprovalSnapshot[];
  context?: RemoteScope & { actor: RemoteActor };
  [key: string]: unknown;
}
export interface ApprovalSnapshot {
  approval: { id: string; [key: string]: unknown };
  context: RemoteScope & { approvalId: string; [key: string]: unknown };
}

export class RemoteGatewayService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewing?: Promise<void>;
  constructor(
    readonly client: RunnerClient,
    readonly store: RemoteRoutingStore,
  ) {}

  requireCloud(hostId: string): void {
    this.client.forHost(hostId);
  }

  async projects(actor: RemoteActor, hostId = "cloud"): Promise<CloudProject[]> {
    if (!this.store.sessionAlive(actor)) throw new AppError(ErrorCode.Unauthorized, "请重新登录");
    const result = await this.client
      .forHost(hostId)
      .json<{ hostId: string; projects: CloudProject[] }>("/host/projects");
    if (result.hostId !== hostId)
      throw new AppError(ErrorCode.ServiceUnavailable, "云端宿主身份不匹配");
    return result.projects.map((p) => ({
      id: RemoteId.parse(p.id),
      name: p.name,
      workspaceId: RemoteId.parse(p.workspaceId),
      workspaceMode: p.workspaceMode,
    }));
  }

  async scope(
    actor: RemoteActor,
    hostId: string,
    projectId: string,
    workspaceId?: string,
  ): Promise<RemoteScope> {
    this.requireCloud(hostId);
    const project = (await this.projects(actor, hostId)).find((p) => p.id === projectId);
    if (!project || (workspaceId !== undefined && workspaceId !== project.workspaceId))
      throw new AppError(ErrorCode.NotFound, "项目或工作区不存在");
    return {
      userId: actor.userId,
      hostId,
      projectId: project.id,
      workspaceId: project.workspaceId,
    };
  }

  async tasks(
    actor: RemoteActor,
    hostId: string,
    projectId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    this.requireCloud(hostId);
    const projects = await this.projects(actor, hostId);
    const selected = projectId ? projects.filter((p) => p.id === projectId) : projects;
    if (projectId && !selected.length) throw new AppError(ErrorCode.NotFound, "项目不存在");
    const tasks: Array<Record<string, unknown>> = [];
    for (const p of selected) {
      const scope = { userId: actor.userId, hostId, projectId: p.id, workspaceId: p.workspaceId };
      const result = await this.client.execute<{ tasks: Array<Record<string, unknown>> }>(
        scope,
        actor,
        "task.read",
        {},
      );
      tasks.push(
        ...result.tasks.map((task) => ({
          ...task,
          projectId: p.id,
          workspaceId: p.workspaceId,
          hostId,
        })),
      );
    }
    return tasks;
  }

  async taskScope(actor: RemoteActor, hostId: string, taskId: string): Promise<RemoteScope> {
    RemoteId.parse(taskId);
    const task = (await this.tasks(actor, hostId)).find((task) => task.id === taskId);
    if (!task) throw new AppError(ErrorCode.NotFound, "任务不存在");
    return {
      userId: actor.userId,
      hostId,
      projectId: String(task.projectId),
      workspaceId: String(task.workspaceId),
    };
  }

  async submit(
    actor: RemoteActor,
    hostId: string,
    projectId: string,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const body = RemoteTaskInput.parse(input);
    const scope = await this.scope(actor, hostId, projectId, body.workspaceId);
    const submission = this.store.claim({
      scope,
      actor,
      requestId: body.clientRequestId,
      payloadHash: commandDigest(body),
      taskId: null,
      active: true,
    });
    const result = await this.client.execute<Record<string, unknown>>(
      scope,
      actor,
      "task.create",
      body,
      body.clientRequestId,
    );
    const task = result.task as { id?: string } | undefined;
    if (task?.id) {
      this.store.accept(submission, RemoteId.parse(task.id));
    }
    return result;
  }

  async approvals(actor: RemoteActor, hostId = "cloud"): Promise<ApprovalSnapshot[]> {
    const all: ApprovalSnapshot[] = [];
    for (const p of await this.projects(actor, hostId)) {
      const scope = {
        userId: actor.userId,
        hostId,
        projectId: p.id,
        workspaceId: p.workspaceId,
      };
      const result = await this.client.execute<{ approvals: ApprovalSnapshot[] }>(
        scope,
        actor,
        "project.read",
        { kind: "approvals" },
      );
      all.push(...result.approvals.filter((item) => item.context?.userId === actor.userId));
    }
    return all;
  }

  async approvalScope(actor: RemoteActor, hostId: string, id: string): Promise<RemoteScope> {
    this.requireCloud(hostId);
    RemoteId.parse(id);
    for (const p of await this.projects(actor, hostId)) {
      const scope = { userId: actor.userId, hostId, projectId: p.id, workspaceId: p.workspaceId };
      try {
        const found = await this.client.execute<ApprovalSnapshot>(scope, actor, "project.read", {
          kind: "approval",
          approvalId: id,
        });
        if (
          found.context?.userId === actor.userId &&
          found.context.hostId === hostId &&
          found.context.projectId === p.id &&
          found.context.workspaceId === p.workspaceId &&
          found.approval.id === id
        )
          return scope;
      } catch (error) {
        if (!(error instanceof AppError && error.code === ErrorCode.NotFound)) throw error;
      }
    }
    throw new AppError(ErrorCode.NotFound, "审批不存在");
  }

  async followup(
    actor: RemoteActor,
    scope: RemoteScope,
    taskId: string,
    message: string,
    requestId: string,
  ) {
    const payload = { taskId, message, clientRequestId: RemoteId.parse(requestId) };
    const submission = this.store.claim({
      scope,
      actor,
      requestId,
      payloadHash: commandDigest(payload),
      taskId,
      active: true,
      action: "task.followup",
      accepted: false,
    });
    const result = await this.client.execute<{ task: { id: string }; [key: string]: unknown }>(
      scope,
      actor,
      "task.followup",
      payload,
      requestId,
    );
    this.store.accept(submission, RemoteId.parse(result.task.id));
    return result;
  }

  async operation(actor: RemoteActor, hostId: string, id: string) {
    this.requireCloud(hostId);
    RemoteId.parse(id);
    for (const p of await this.projects(actor, hostId)) {
      const scope = { userId: actor.userId, hostId, projectId: p.id, workspaceId: p.workspaceId };
      await this.client.grant(scope);
      const payload = { operationId: id };
      const result = await this.client.json<{ operation: Record<string, unknown> | null }>(
        `/operations/${id}`,
        {
          command: this.client.command(scope, actor, "task.read", payload),
          payload,
        },
      );
      if (result.operation) return result;
    }
    throw new AppError(ErrorCode.NotFound, "操作不存在");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.renew();
    }, 15_000);
    this.timer.unref();
    void this.renew();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.renewing;
  }

  /** 会话存续期间独立续租，完全不依赖手机 SSE 连接；进程重启从 SQLite 恢复。 */
  renew(): Promise<void> {
    return (this.renewing ??= this.renewActive().finally(() => {
      this.renewing = undefined;
    }));
  }
  private async renewActive(): Promise<void> {
    for (const submission of this.store.active()) {
      try {
        await this.renewOne(submission);
      } catch {
        // 断网后保留对账记录，绝不重新派发 task.create 或推进原请求。
      }
    }
  }

  private async renewOne(submission: RemoteSubmission): Promise<void> {
    const { scope, actor } = submission;
    if (!this.store.sessionAlive(actor)) {
      submission.active = false;
      this.store.save(submission);
      if (submission.taskId && submission.accepted) {
        const payload = { taskId: submission.taskId, leaseExpiresAt: new Date().toISOString() };
        await this.client.grant(scope);
        await this.client.json(`/tasks/${submission.taskId}/lease`, {
          command: this.client.command(scope, actor, "task.read", payload),
          payload,
        });
      }
      return;
    }
    await this.client.grant(scope);
    if (!submission.accepted || !submission.taskId) {
      const payload = {
        action: submission.action ?? "task.create",
        requestId: submission.requestId,
      };
      const result = await this.client.json<{
        operation: { result: { taskId?: string } | null; status: string } | null;
      }>("/operations/lookup", {
        command: this.client.command(scope, actor, "task.read", payload),
        payload,
      });
      if (result.operation?.result?.taskId) {
        const snapshot = await this.client.execute<TaskSnapshot>(scope, actor, "task.read", {
          taskId: result.operation.result.taskId,
        });
        if (snapshot.context && snapshot.context.actor.sessionId !== actor.sessionId) {
          submission.active = false;
          this.store.save(submission);
          return;
        }
        this.store.accept(submission, RemoteId.parse(result.operation.result.taskId));
      } else {
        if (Date.now() - (submission.createdAt ?? 0) > 60_000) {
          submission.active = false;
          this.store.save(submission);
        }
        return;
      }
    }
    const snapshot = await this.client.execute<TaskSnapshot>(scope, actor, "task.read", {
      taskId: submission.taskId,
    });
    if (snapshot.context && snapshot.context.actor.sessionId !== actor.sessionId) {
      submission.active = false;
      this.store.save(submission);
      return;
    }
    if (
      ["succeeded", "failed", "cancelled", "completed", "closed"].includes(snapshot.task.status)
    ) {
      submission.active = false;
      this.store.save(submission);
      return;
    }
    const payload = {
      taskId: submission.taskId,
      leaseExpiresAt: new Date(Date.now() + 40_000).toISOString(),
    };
    await this.client.json(`/tasks/${submission.taskId}/lease`, {
      command: this.client.command(scope, actor, "task.read", payload),
      payload,
    });
  }
}

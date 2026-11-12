import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteTaskInput,
  type RemoteCommand,
  type RemoteScope,
} from "@agentdesk/shared";
import type { DbHandle } from "../../db/client";
import type { TaskService } from "../tasks";
import { TaskSubmissionService } from "../task-submissions";
import type { RemoteGrantStore } from "./grants";
import { RemoteOperationStore } from "./operations";
import { attachRemoteTask } from "./task-contexts";
const TaskResult = z.strictObject({ taskId: z.string(), runId: z.string() });
/** 接收与执行分开：提交后由受限执行入口重新授权、调度；HTTP 断线不会拥有任务生命周期。 */
export class RemoteTaskSubmissionService {
  constructor(
    private readonly handle: DbHandle,
    private readonly tasks: TaskService,
    private readonly grants: RemoteGrantStore,
    private readonly resolveWorkspace: (scope: RemoteScope) => Promise<string>,
    private readonly codexAvailable: () => Promise<boolean> = async () => false,
  ) {}
  async submit(command: RemoteCommand, input: RemoteTaskInput) {
    const body = RemoteTaskInput.parse(input);
    await this.grants.authorize(command, body);
    if (
      command.action !== "task.create" ||
      command.requestId !== body.clientRequestId ||
      command.workspaceId !== body.workspaceId
    )
      throw new AppError(ErrorCode.Forbidden, "任务与已授权操作不匹配");
    if (
      (body.executor === "codex" && !(await this.codexAvailable())) ||
      body.workspaceMode !== "existing"
    )
      throw new AppError(ErrorCode.BadRequest, "当前入口尚未启用此执行器或工作区模式");
    const { userId, hostId, projectId, workspaceId } = command;
    const scope = { userId, hostId, projectId, workspaceId };
    const workspace = await this.resolveWorkspace(scope);
    // 路径解析可能跨异步边界；认领写操作前重新检查撤销和 lease。
    await this.grants.authorize(command, body);
    const submissions = new TaskSubmissionService(this.handle, this.tasks);
    const accepted = await new RemoteOperationStore(this.tasks.business).acceptAsync(
      scope,
      "task.create",
      body.clientRequestId,
      body,
      async (operationId) => {
        const { task, run } = await submissions.submit({
          goal: body.goal,
          title: body.title,
          requiresPlanApproval: body.requiresPlanApproval,
          workspace,
        });
        const grant = await this.grants.get(scope);
        if (!grant || grant.revokedAt || grant.connectionEpoch !== command.connectionEpoch)
          throw new AppError(ErrorCode.Forbidden, "Project grant changed before task creation");
        await attachRemoteTask(this.tasks.business, {
          ...scope,
          operationId,
          taskId: task.id,
          actor: command.actor,
          executor: body.executor,
          connectionEpoch: command.connectionEpoch,
          leaseExpiresAt: new Date(
            Math.min(Date.now() + 45000, Date.parse(grant.expiresAt)),
          ).toISOString(),
        });
        return { taskId: task.id, runId: run.id };
      },
      async (action) => await this.tasks.transaction(action),
    );
    const ids = TaskResult.parse(accepted.operation.result);
    const task = await this.tasks.get(ids.taskId);
    const run = await this.tasks.getRun(ids.runId);
    if (!task || !run) throw new AppError(ErrorCode.Conflict, "操作对应任务缺失，需要对账");
    return { ...accepted, task, run };
  }
}

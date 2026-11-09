import { z } from "zod";
import {
  AgentName,
  AppError,
  ErrorCode,
  RemoteId,
  type Conversation,
  type Run,
  type Task,
} from "@agentdesk/shared";
import type { DbHandle } from "../db/client";
import { Collection } from "../db/collection";
import { newId, nowIso } from "../util";
import type { TaskService } from "./tasks";
import { payloadDigest } from "./remote/digest";

export const TaskSubmissionInput = z.strictObject({
  goal: z.string().min(1),
  title: z.string().optional(),
  agent: AgentName.default("orchestrator"),
  requiresPlanApproval: z.boolean().default(false),
  conversationId: z.string().min(1).optional(),
  idempotencyKey: RemoteId.optional(),
  workspace: z.string().min(1).max(4096).optional(),
});
export type TaskSubmissionInput = z.input<typeof TaskSubmissionInput>;

/** 创建完整资源图后才返回；调用方必须在事务提交后调度 Run。 */
export class TaskSubmissionService {
  constructor(
    private readonly handle: DbHandle,
    private readonly tasks: TaskService,
  ) {}

  submit(input: TaskSubmissionInput): { task: Task; run: Run; replayed: boolean } {
    const body = TaskSubmissionInput.parse(input);
    const { idempotencyKey, ...content } = body;
    const hash = payloadDigest(JSON.parse(JSON.stringify(content)));
    return this.handle.raw
      .transaction(() => {
        if (idempotencyKey) {
          const row = this.handle.raw
            .prepare("SELECT payload_hash,task_id,run_id FROM task_submissions WHERE request_id=?")
            .get(idempotencyKey) as
            { payload_hash: string; task_id: string; run_id: string } | undefined;
          if (row) {
            if (row.payload_hash !== hash)
              throw new AppError(ErrorCode.IdempotencyConflict, "幂等键对应的任务内容不同");
            const task = this.tasks.get(row.task_id);
            const run = this.tasks.getRun(row.run_id);
            if (!task || !run) throw new AppError(ErrorCode.Conflict, "原任务资源缺失，需要核对");
            return { task, run, replayed: true };
          }
        }
        const conversations = new Collection<Conversation>(this.handle.db, "conversations");
        let conversationId = body.conversationId;
        if (conversationId) {
          if (!conversations.get(conversationId))
            throw new AppError(ErrorCode.NotFound, "会话不存在");
          this.tasks.assertConversationAvailable(conversationId);
        } else {
          const now = nowIso();
          conversationId = conversations.put({
            id: newId(),
            title: body.goal.slice(0, 40),
            createdAt: now,
            updatedAt: now,
          }).id;
        }
        const task = this.tasks.create({ ...body, conversationId });
        const run = this.tasks.createRun({
          taskId: task.id,
          kind: "root",
          agent: body.agent,
          trigger: "create",
          idempotencyKey,
          input: {
            userMessage: body.goal,
            ...(body.workspace ? { workspace: body.workspace } : {}),
          },
        });
        const queued = this.tasks.transition(task.id, "queued");
        if (idempotencyKey)
          this.handle.raw
            .prepare("INSERT INTO task_submissions VALUES (?,?,?,?,?)")
            .run(idempotencyKey, hash, task.id, run.id, nowIso());
        return { task: queued, run, replayed: false };
      })
      .immediate();
  }
}

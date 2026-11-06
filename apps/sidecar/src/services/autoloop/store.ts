import { createHash } from "node:crypto";
import {
  AppError,
  ErrorCode,
  type AutomationBinding,
  type AutomationCard,
  type AutomationStatus,
  type ToolCallRecord,
} from "@agentdesk/shared";
import type { DurableCheckpoint } from "@agentdesk/agent-core";
import type { HubJob } from "@agentdesk/integrations";
import { Collection } from "../../db/collection";
import type { Db } from "../../db/client";
import { nowIso } from "../../util";

export const stableId = (...parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface RunLink {
  id: string;
  bindingId: string;
  remoteRunId: number;
  attempt: number;
  taskId: string;
  runId: string;
  session: string;
  job: Omit<HubJob, "token">;
  claim: string;
  state: "prepared" | "running" | "submitted" | "attention";
}
export interface CheckpointRecord {
  id: string;
  epoch: number;
  checkpoint: DurableCheckpoint;
}
export interface OutboxCommand {
  id: string;
  operation: "event" | "started" | "result" | "answer" | "cancel" | "resolve";
  body: string;
  target?: number;
  linkId?: string;
  bindingId?: string;
  status: "pending" | "delivered" | "conflict";
  response?: unknown;
  outcome?: { status: AutomationStatus; text: string; toolCalls: ToolCallRecord[] };
}
export interface AnswerRecord {
  id: string;
  cardId: string;
  body: string;
  commandId: string;
  answerId: string;
}

/** 后端私有集合；复合 ID 是 SQLite 主键，跨集合变更统一在同一事务中提交。 */
export class AutoloopStore {
  readonly bindings: Collection<AutomationBinding>;
  readonly cards: Collection<AutomationCard>;
  readonly links: Collection<RunLink>;
  readonly checkpoints: Collection<CheckpointRecord>;
  readonly outbox: Collection<OutboxCommand>;
  readonly answers: Collection<AnswerRecord>;
  readonly state: Collection<{ id: string; value: number }>;
  readonly stopped: Collection<{ id: string; at: string }>;
  readonly stoppedSynced: Collection<{ id: string }>;
  readonly workspaces: Collection<{ id: string; realPath: string }>;
  readonly budgets: Collection<{ id: string; elapsedMs: number }>;
  readonly interactionKeys: Collection<{
    id: string;
    key: string;
    choice: number | null;
    answer: string | null;
  }>;
  readonly followups: Collection<{
    id: string;
    taskId: string;
    message: string;
    commandId: string;
    consumed: boolean;
  }>;
  epoch = 0;
  constructor(readonly db: Db) {
    this.bindings = new Collection(db, "autoloop_bindings_v1");
    this.cards = new Collection(db, "autoloop_cards_v1");
    this.links = new Collection(db, "autoloop_links_v1");
    this.checkpoints = new Collection(db, "autoloop_checkpoints_v1");
    this.outbox = new Collection(db, "autoloop_outbox_v1");
    this.answers = new Collection(db, "autoloop_answers_v1");
    this.state = new Collection(db, "autoloop_state_v1");
    this.stopped = new Collection(db, "autoloop_stopped_v1");
    this.stoppedSynced = new Collection(db, "autoloop_stopped_synced_v1");
    this.workspaces = new Collection(db, "autoloop_workspaces_v1");
    this.budgets = new Collection(db, "autoloop_budgets_v1");
    this.interactionKeys = new Collection(db, "autoloop_interaction_keys_v1");
    this.followups = new Collection(db, "autoloop_followups_v1");
  }
  acquireEpoch(): void {
    this.db.transaction(() => {
      this.epoch = (this.state.get("epoch")?.value ?? 0) + 1;
      this.state.put({ id: "epoch", value: this.epoch });
    });
  }
  assertEpoch(): void {
    if (!this.epoch || this.state.get("epoch")?.value !== this.epoch)
      throw new AppError(ErrorCode.Conflict, "执行宿主已更新，请重新连接");
  }
  ownsEpoch(): boolean {
    return this.epoch > 0 && this.state.get("epoch")?.value === this.epoch;
  }
  saveCheckpoint(taskId: string, checkpoint: DurableCheckpoint): void {
    this.db.transaction(() => {
      this.assertEpoch();
      if (this.stopped.get(taskId)) throw new AppError(ErrorCode.Conflict, "任务已停止");
      const previous = this.checkpoints.get(taskId);
      if ((previous?.checkpoint.revision ?? 0) + 1 !== checkpoint.revision)
        throw new AppError(ErrorCode.Conflict, "检查点已更新，不能覆盖新的执行结果");
      this.checkpoints.put({ id: taskId, epoch: this.epoch, checkpoint });
    });
  }
  enqueue(command: Omit<OutboxCommand, "status">): OutboxCommand {
    return this.db.transaction(() => {
      this.assertEpoch();
      const existing = this.outbox.get(command.id);
      if (existing) {
        if (existing.body !== command.body || existing.operation !== command.operation)
          throw new AppError(ErrorCode.Conflict, "同一命令不能提交不同内容");
        return existing;
      }
      return this.outbox.put({ ...command, status: "pending" });
    });
  }
  stopTask(taskId: string): void {
    this.stopped.put({ id: taskId, at: nowIso() });
  }
}

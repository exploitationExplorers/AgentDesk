import { z } from "zod";
import type { AgentStreamEvent } from "./chat";
import { AgentName } from "./provider";

export const TaskStatus = z.enum([
  "pending",
  "queued",
  "planning",
  "awaiting_plan_approval",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
  "closed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  agent: AgentName.nullable(),
  conversationId: z.string(),
  requiresPlanApproval: z.boolean(),
  status: TaskStatus,
  currentRunId: z.string().nullable(),
  pendingApprovalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunKind = z.enum(["root", "delegate"]);
export type RunKind = z.infer<typeof RunKind>;

export const RunTrigger = z.enum(["create", "continue", "followup", "resume", "delegate"]);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const Run = z.object({
  id: z.string(),
  taskId: z.string(),
  parentRunId: z.string().nullable(),
  kind: RunKind,
  agent: AgentName,
  status: RunStatus,
  trigger: RunTrigger,
  idempotencyKey: z.string().nullable(),
  input: z.object({
    userMessage: z.string(),
    context: z.string().optional(),
    workspace: z.string().min(1).max(4096).optional(),
  }),
  resultText: z.string().nullable(),
  resultError: z.string().nullable(),
  toolCalls: z.array(z.unknown()).nullable(),
  cancelRequested: z.boolean(),
  cancelRequestedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof Run>;

export const ArtifactKind = z.enum(["plan", "change", "test_result", "file", "summary"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().nullable(),
  kind: ArtifactKind,
  version: z.number().int(),
  title: z.string(),
  content: z.string().nullable(),
  filePath: z.string().nullable(),
  mimeType: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

/** Task/Run 专用的内部事件流，复用 AgentStreamEvent 的全部 variant 并追加任务级事件。 */
export type TaskStreamEvent =
  | AgentStreamEvent
  | {
      type: "run_started";
      runId: string;
      parentRunId: string | null;
      agent: AgentName;
      trigger: RunTrigger;
    }
  | { type: "run_ended"; runId: string; status: RunStatus; error?: string }
  | { type: "task_status"; status: TaskStatus }
  | { type: "plan_updated"; artifactId: string; version: number };

export interface RunEventRecord {
  seq: number;
  taskId: string;
  runId: string;
  parentRunId: string | null;
  event: TaskStreamEvent;
  createdAt: string;
}

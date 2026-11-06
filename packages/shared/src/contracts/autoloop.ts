import { z } from "zod";

export const AutomationStatus = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_authorization",
  "waiting_timer",
  "retry_scheduled",
  "needs_attention",
  "completed",
  "cancelled",
]);
export type AutomationStatus = z.infer<typeof AutomationStatus>;
export const AutoloopConnection = z.object({
  id: z.string(),
  hubId: z.string(),
  health: z.enum(["unknown", "healthy", "degraded", "unavailable"]),
  protocolVersion: z.string(),
  lastSyncedAt: z.string().nullable(),
});
export type AutoloopConnection = z.infer<typeof AutoloopConnection>;
export const AutoloopStatus = z.object({
  available: z.boolean(),
  mode: z.enum(["disabled", "local"]),
  protocolVersion: z.string().nullable(),
  connections: z.array(AutoloopConnection),
  lastSyncedAt: z.string().nullable(),
});
export type AutoloopStatus = z.infer<typeof AutoloopStatus>;
export const WorkspacePolicy = z
  .object({
    root: z.string().trim().min(1).max(4096),
    allowSubdirectories: z.boolean().default(false),
  })
  .strict();
export const AutomationSchedule = z
  .object({
    cron: z.string().trim().min(1).max(100),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "时区无效"),
  })
  .strict();
export const AutomationBindingInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(4000),
    projectId: z.string().min(1).nullable().optional(),
    workspacePolicy: WorkspacePolicy,
    schedule: AutomationSchedule.nullable().optional(),
    maxRounds: z.number().int().min(1).max(100).default(20),
    maxMinutes: z.number().int().min(1).max(120).default(30),
    maxTokens: z.number().int().positive().max(10000000).optional(),
    maxCostUsd: z.number().positive().max(10000).optional(),
  })
  .strict();
export type AutomationBindingInput = z.infer<typeof AutomationBindingInput>;
export const AutomationBinding = AutomationBindingInput.extend({
  id: z.string(),
  automationId: z.string(),
  hubId: z.string(),
  ruleName: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationBinding = z.infer<typeof AutomationBinding>;
export const AutomationCard = z.object({
  id: z.string(),
  bindingId: z.string(),
  hubId: z.string(),
  remoteCardId: z.string(),
  version: z.number().int().positive(),
  kind: z.enum(["ask", "notice"]),
  interactionKind: z.enum(["input", "authorization", "notice"]),
  state: z.enum(["open", "answered", "decided", "done"]),
  taskId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  options: z.array(z.string()),
  answerId: z.string().nullable(),
  answerText: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationCard = z.infer<typeof AutomationCard>;
export const AutoloopEventInput = z.object({ eventId: z.string().trim().min(1).max(180) }).strict();
export type AutoloopEventInput = z.infer<typeof AutoloopEventInput>;
export const AutomationFollowupInput = z
  .object({
    message: z.string().trim().min(1).max(4000),
    eventId: z.string().trim().min(1).max(180),
  })
  .strict();
export type AutomationFollowupInput = z.infer<typeof AutomationFollowupInput>;
export const AutoloopInteractionAnswer = z
  .object({
    cardVersion: z.number().int().positive(),
    answerId: z.string().trim().min(1).max(200),
    choice: z.number().int().min(0).max(4).optional(),
    text: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .refine((a) => a.choice !== undefined || Boolean(a.text), "请选择或填写回答");
export type AutoloopInteractionAnswer = z.infer<typeof AutoloopInteractionAnswer>;
export type AutoloopPublicEvent =
  | { type: "automation_status"; status: AutomationStatus }
  | { type: "interaction_required"; card: AutomationCard }
  | { type: "interaction_resolved"; card: AutomationCard };

import { z } from "zod";

export const RiskLevel = z.enum(["safe", "confirm", "dangerous"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** ActionDraft：危险操作先落草稿，人工确认后再执行。 */
export const Approval = z.object({
  id: z.string(),
  kind: z.enum(["tool", "deploy", "workflow"]),
  title: z.string(),
  detail: z.string(),
  risk: RiskLevel,
  payload: z.unknown(),
  status: ApprovalStatus,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

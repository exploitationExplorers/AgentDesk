import { z } from "zod";

export const RiskLevel = z.enum(["safe", "confirm", "dangerous"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** 解释这次为什么仍然需要人工确认：没有命中任何已保存的规则，还是分类器明确说需要确认。 */
export const ApprovalReason = z.union([
  z.object({ type: z.literal("default") }),
  z.object({ type: z.literal("classifier_declined"), note: z.string() }),
]);
export type ApprovalReason = z.infer<typeof ApprovalReason>;

/** 用户在审批时选择"以后不再询问"后持久化的规则；目前只支持 shell.run 的命令前缀匹配。 */
export const PermissionRule = z.object({
  id: z.string(),
  tool: z.literal("shell.run"),
  prefix: z.string().min(1),
  createdAt: z.string(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

/** ActionDraft：危险操作先落草稿，人工确认后再执行。 */
export const Approval = z.object({
  id: z.string(),
  kind: z.enum(["tool", "deploy", "workflow", "question", "plan", "review"]),
  title: z.string(),
  detail: z.string(),
  risk: RiskLevel,
  payload: z.unknown(),
  reason: ApprovalReason.optional(),
  status: ApprovalStatus,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

import { z } from "zod";

export const InsightSuggestion = z.object({
  id: z.string(),
  title: z.string().min(1).max(120),
  status: z.enum(["existing", "partial", "new"]),
  priority: z.enum(["high", "medium", "low"]),
  effort: z.enum(["small", "medium", "large"]),
  rationale: z.string().max(2000),
  proposal: z.string().max(3000),
  sourceQuote: z.string().max(1000),
  evidence: z.array(z.object({ path: z.string(), detail: z.string().max(1000) })).max(10),
  acceptance: z.array(z.string().max(500)).min(1).max(8),
  taskId: z.string().nullable(),
});
export type InsightSuggestion = z.infer<typeof InsightSuggestion>;

export const ProjectInsight = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  workspace: z.string(),
  title: z.string(),
  sourceUrl: z.string().nullable(),
  sourceText: z.string(),
  analysisTaskId: z.string(),
  analysisRunId: z.string(),
  status: z.enum(["analyzing", "ready", "failed"]),
  summary: z.string(),
  reviewedFiles: z.array(z.string()),
  suggestions: z.array(InsightSuggestion),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectInsight = z.infer<typeof ProjectInsight>;

export const ProjectInsightInput = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(200).default("资料分析"),
    sourceUrl: z.string().url().max(4096).optional(),
    sourceText: z.string().trim().max(60_000).optional(),
  })
  .refine((value) => value.sourceUrl || (value.sourceText && value.sourceText.length >= 30), {
    message: "请提供文章链接或至少 30 字的资料正文",
  });
export type ProjectInsightInput = z.infer<typeof ProjectInsightInput>;

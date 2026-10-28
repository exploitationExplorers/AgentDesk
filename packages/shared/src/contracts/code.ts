import { z } from "zod";

/** 实际落盘后的差异；truncated 表示展示内容被截断，统计仍覆盖完整改动。 */
export const FileChange = z.object({
  path: z.string(),
  operation: z.enum(["create", "edit"]),
  additions: z.number(),
  deletions: z.number(),
  diff: z.string(),
  truncated: z.boolean(),
  beforeHash: z.string().nullable(),
  afterHash: z.string(),
});
export type FileChange = z.infer<typeof FileChange>;

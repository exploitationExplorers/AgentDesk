import { z } from "zod";

export const DiskTier = z.enum(["primary", "optional", "keep"]);
export type DiskTier = z.infer<typeof DiskTier>;

export const DiskCategory = z.enum(["browser", "dev", "app", "ai", "user", "system", "other"]);
export type DiskCategory = z.infer<typeof DiskCategory>;

export const DiskMode = z.enum(["contents", "whole", "recycle"]);
export type DiskMode = z.infer<typeof DiskMode>;

/** 当前用户目录所在卷的剩余空间。检测本身不调用模型。 */
export const DiskStatus = z.object({
  platform: z.enum(["win32", "darwin", "linux", "other"]),
  volumePath: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  usedBytes: z.number(),
  thresholdBytes: z.number(),
  low: z.boolean(),
});
export type DiskStatus = z.infer<typeof DiskStatus>;

export const DiskCandidate = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  bytes: z.number(),
  tier: DiskTier,
  category: DiskCategory,
  reason: z.string(),
  mode: DiskMode,
  regenerable: z.boolean(),
  protected: z.boolean(),
  /** keep 与受保护路径不可勾选 */
  selectable: z.boolean(),
  daysSinceUsed: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type DiskCandidate = z.infer<typeof DiskCandidate>;

export const DiskScan = z.object({
  id: z.string(),
  scannedAt: z.string(),
  status: DiskStatus,
  summary: z.string(),
  items: z.array(DiskCandidate),
  primaryBytes: z.number(),
  optionalBytes: z.number(),
  partial: z.boolean(),
});
export type DiskScan = z.infer<typeof DiskScan>;

export const DiskCleanRequest = z.object({
  scanId: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(200),
});
export type DiskCleanRequest = z.infer<typeof DiskCleanRequest>;

export const DiskCleanResult = z.object({
  freedBytes: z.number(),
  cleaned: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      bytes: z.number(),
      action: z.enum(["delete", "trash"]),
    }),
  ),
  skipped: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      reason: z.string(),
    }),
  ),
});
export type DiskCleanResult = z.infer<typeof DiskCleanResult>;

import { z } from "zod";

export const DiskTier = z.enum(["primary", "optional", "keep"]);
export type DiskTier = z.infer<typeof DiskTier>;

export const DiskCategory = z.enum(["browser", "dev", "app", "ai", "user", "system", "other"]);
export type DiskCategory = z.infer<typeof DiskCategory>;

export const DiskMode = z.enum(["contents", "whole", "recycle"]);
export type DiskMode = z.infer<typeof DiskMode>;

export const DiskVolume = z.object({
  volumePath: z.string(),
  label: z.string(),
  isHome: z.boolean(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  usedBytes: z.number(),
  thresholdBytes: z.number(),
  low: z.boolean(),
});
export type DiskVolume = z.infer<typeof DiskVolume>;

/** 所选磁盘与本机可用磁盘列表。检测本身不调用模型。 */
export const DiskStatus = DiskVolume.extend({
  platform: z.enum(["win32", "darwin", "linux", "other"]),
  volumes: z.array(DiskVolume),
});
export type DiskStatus = z.infer<typeof DiskStatus>;

export const DiskScanRequest = z.object({
  volumePath: z.string().min(1).optional(),
});

export const DiskUsageEntry = z.object({
  path: z.string(),
  title: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
});
export type DiskUsageEntry = z.infer<typeof DiskUsageEntry>;

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
  usage: z.array(DiskUsageEntry).default([]),
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

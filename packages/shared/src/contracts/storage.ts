import { z } from "zod";

export const StoragePolicy = z.object({
  automaticCleanup: z.boolean().default(false),
  screenshotDays: z.number().int().min(1).max(3650).default(3),
  traceDays: z.number().int().min(1).max(3650).default(7),
  eventDays: z.number().int().min(1).max(3650).default(30),
  cacheLimitMiB: z.number().int().min(64).max(1_048_576).default(2048),
  reserveGiB: z.number().min(1).max(2048).default(5),
  reservePercent: z.number().min(0).max(25).default(5),
});
export type StoragePolicy = z.infer<typeof StoragePolicy>;

export interface StorageUsageItem {
  name: string;
  bytes: number;
  files: number;
  incomplete: boolean;
  protected: boolean;
}

export interface StorageUsage {
  measuredAt: string;
  dataDir: string;
  items: StorageUsageItem[];
  totalBytes: number;
  incomplete: boolean;
  disk: { totalBytes: number; freeBytes: number; reserveBytes: number } | null;
  warnings: string[];
}

export interface StorageCleanupPreview {
  id: string;
  expiresAt: string;
  files: number;
  fileBytes: number;
  events: number;
  traces: number;
  warnings: string[];
}

export interface StorageCleanupResult {
  files: number;
  fileBytes: number;
  events: number;
  traces: number;
  skipped: number;
  completedAt: string;
}

export const EventHistoryExpired = z.object({
  type: z.literal("history_expired"),
  prunedThrough: z.number().int().nonnegative(),
  message: z.string(),
});
export type EventHistoryExpired = z.infer<typeof EventHistoryExpired>;

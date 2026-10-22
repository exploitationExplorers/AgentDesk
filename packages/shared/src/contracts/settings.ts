import { z } from "zod";

export const AppSettings = z.object({
  scanRoots: z.array(z.string()).default([]),
  feedLanguages: z.array(z.string()).default(["", "typescript", "python", "rust", "go"]),
  feedSchedule: z.string().default("09:00"),
  browserChannel: z.enum(["msedge", "chrome"]).default("msedge"),
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  /** 侧栏和首页使用的头像，空字符串表示默认图标。内容是压缩后的 data URL */
  avatar: z.string().max(400_000).default(""),
  cursorCommand: z.string().default("cursor"),
  claudeCommand: z.string().default("claude"),
  /** 为空时依次使用 HTTPS_PROXY 环境变量、Windows 系统代理 */
  proxy: z.string().default(""),
  /** 剩余空间低于该值时，侧栏和磁盘页提示清理 */
  diskThresholdGB: z.number().min(1).max(2048).default(15),
  /** 需用户决定的项目：移到回收站，或直接删除 */
  diskOptionalAction: z.enum(["trash", "delete"]).default("trash"),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const HealthInfo = z.object({
  ok: z.boolean(),
  version: z.string(),
  dataDir: z.string(),
  secretBackend: z.enum(["keychain", "dev-file"]),
  providers: z.number(),
  proxy: z.string().nullable(),
});
export type HealthInfo = z.infer<typeof HealthInfo>;

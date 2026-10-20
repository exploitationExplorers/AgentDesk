import { z } from "zod";

export const AppSettings = z.object({
  scanRoots: z.array(z.string()).default([]),
  feedLanguages: z.array(z.string()).default(["", "typescript", "python", "rust", "go"]),
  feedSchedule: z.string().default("09:00"),
  browserChannel: z.enum(["msedge", "chrome"]).default("msedge"),
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  cursorCommand: z.string().default("cursor"),
  claudeCommand: z.string().default("claude"),
  /** 为空时依次使用 HTTPS_PROXY 环境变量、Windows 系统代理 */
  proxy: z.string().default(""),
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

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome } from "./state.js";

export const THEME_PALETTES = ["dark", "light", "colorblind"] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number];

export interface CliPreferences {
  theme?: ThemePalette;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** 用户级终端偏好（目前只有主题），和 service.json 这种进程级状态分开存放。 */
export function readPreferences(home: string): CliPreferences {
  const file = join(home, "preferences.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return {};
    return {}; // 格式损坏不阻断启动，等同于没有偏好
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const theme = (parsed as Record<string, unknown>).theme;
  return THEME_PALETTES.includes(theme as ThemePalette) ? { theme: theme as ThemePalette } : {};
}

export function writePreferences(home: string, patch: Partial<CliPreferences>): CliPreferences {
  ensureHome(home);
  const next = { ...readPreferences(home), ...patch };
  const file = join(home, "preferences.json");
  const temp = join(home, `preferences-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(next, null, 2));
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
  return next;
}

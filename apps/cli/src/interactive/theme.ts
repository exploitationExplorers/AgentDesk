/** 终端"设计 token"：调色板、图标和无障碍开关，供手搓 UI（ui.mjs）与 Ink 组件共用。 */

import { THEME_PALETTES, type ThemePalette } from "../preferences.js";

export const SPECTRUM = ["95", "95", "35", "94", "94", "36", "96"];

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const STATUS_MARKS = {
  success: { text: "◇", fallback: "[OK]" },
  error: { text: "■", fallback: "[错误]" },
};

export function paint(color: boolean, code: string, text: unknown) {
  return color ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

export function icon(emoji: boolean, text: string, fallback = "") {
  return emoji ? `${text} ` : fallback;
}

export function mark(
  color: boolean,
  interactive: boolean,
  code: string,
  text: string,
  fallback: string,
) {
  return paint(color, code, interactive ? text : fallback);
}

export function wordmarkCharacters(offset = 0) {
  return [..."A G E N T D E S K"].map((character, index) => ({
    character,
    code: `1;${SPECTRUM[(Math.floor(index / 2) + offset) % SPECTRUM.length]}`,
  }));
}

/** 解析 --plain/--no-color/--no-motion/--no-emoji/--theme 及对应环境变量。读取本地偏好文件
 * 的 I/O 由调用方完成（见 storedTheme），这个函数本身仍是纯函数，方便单测。 */
export interface AccessibilitySettings {
  plain?: boolean;
  "no-color"?: boolean;
  "no-motion"?: boolean;
  "no-emoji"?: boolean;
  theme?: string;
}

export interface AccessibilityTheme {
  interactive: boolean;
  color: boolean;
  motion: boolean;
  emoji: boolean;
  palette: ThemePalette;
}

const VALID_PALETTES = new Set<string>(THEME_PALETTES);

export function resolveAccessibility({
  tty,
  env = process.env,
  settings = {},
  storedTheme,
}: {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  settings?: AccessibilitySettings;
  /** 上次通过 /theme 或 --theme 持久化的选择（见 preferences.ts），没有时用默认值 dark。 */
  storedTheme?: string;
} = {}): AccessibilityTheme {
  const interactive = Boolean(tty && env.TERM !== "dumb" && !settings.plain);
  const color = interactive && !settings["no-color"] && env.NO_COLOR === undefined;
  const motion =
    interactive &&
    !settings["no-motion"] &&
    env.AGENTDESK_REDUCED_MOTION !== "1" &&
    env.CI !== "true" &&
    env.ACCESSIBLE !== "1";
  const emoji = interactive && !settings["no-emoji"] && env.AGENTDESK_NO_EMOJI !== "1";
  const requested = settings.theme ?? env.AGENTDESK_THEME ?? storedTheme;
  const palette = (VALID_PALETTES.has(requested ?? "") ? requested : "dark") as ThemePalette;
  return { interactive, color, motion, emoji, palette };
}

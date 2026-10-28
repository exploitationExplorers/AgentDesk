/** 终端"设计 token"：调色板、图标和无障碍开关，供手搓 UI（ui.mjs）与 Ink 组件共用。 */

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

/** 解析 --plain/--no-color/--no-motion/--no-emoji 及对应环境变量，纯函数、无 I/O。 */
export interface AccessibilitySettings {
  plain?: boolean;
  "no-color"?: boolean;
  "no-motion"?: boolean;
  "no-emoji"?: boolean;
}

export interface AccessibilityTheme {
  interactive: boolean;
  color: boolean;
  motion: boolean;
  emoji: boolean;
}

export function resolveAccessibility({
  tty,
  env = process.env,
  settings = {},
}: {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  settings?: AccessibilitySettings;
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
  return { interactive, color, motion, emoji };
}

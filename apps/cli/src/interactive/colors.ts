/** 语义化配色 token，对齐 Claude Code 终端审批弹窗的色彩语言；受 theme.color 开关统一门控。 */
import type { AccessibilityTheme } from "./theme.js";
import type { ThemePalette } from "../preferences.js";

const TOKENS = {
  permission: "",
  suggestion: "",
  success: "",
  warning: "",
  error: "",
  diffAdded: "",
  diffRemoved: "",
  diffAddedBg: "",
  diffRemovedBg: "",
  brand: "",
  accent: "",
  border: "",
};

export type ColorToken = keyof typeof TOKENS;

export const PALETTES: Record<ThemePalette, Record<ColorToken, string>> = {
  dark: {
    permission: "blue",
    suggestion: "blue",
    success: "green",
    warning: "yellow",
    error: "red",
    diffAdded: "#b6f0cc",
    diffRemoved: "#ffd1d1",
    diffAddedBg: "#153f2c",
    diffRemovedBg: "#4a2025",
    brand: "#72D9BA",
    accent: "cyan",
    border: "gray",
  },
  // 浅色终端背景下收紧对比度：深色前景 + 浅色底色，避免亮绿/亮青在白底上发虚。
  light: {
    permission: "blue",
    suggestion: "blue",
    success: "green",
    warning: "#8a6d1f",
    error: "red",
    diffAdded: "#1a7f37",
    diffRemoved: "#cf222e",
    diffAddedBg: "#d1f7dc",
    diffRemovedBg: "#ffd7d5",
    brand: "#1f8f72",
    accent: "blue",
    border: "gray",
  },
  // Okabe-Ito 色盲友好配色：成功/新增用蓝，警告/错误/删除用橙或朱红，避免红绿难以区分。
  colorblind: {
    permission: "blue",
    suggestion: "blue",
    success: "#0072B2",
    warning: "#E69F00",
    error: "#D55E00",
    diffAdded: "#56B4E9",
    diffRemoved: "#E69F00",
    diffAddedBg: "#0d2b3a",
    diffRemovedBg: "#3a2a0d",
    brand: "#56B4E9",
    accent: "#0072B2",
    border: "gray",
  },
};

/** theme.color 为 false（--no-color / NO_COLOR）时返回 undefined，交给 Ink 按无色渲染。 */
export function pick(token: ColorToken, theme: Pick<AccessibilityTheme, "color" | "palette">): string | undefined {
  return theme.color ? PALETTES[theme.palette][token] : undefined;
}

/**
 * 主题即数据：`/theme` 菜单文案和切换决策集中在这里，和 useSlashCommands.ts 的事件处理分开，
 * 便于独立单测，也便于未来有其他入口（例如设置面板）复用同一套切换逻辑。
 */
import { THEME_PALETTES, type ThemePalette } from "../preferences.js";
import type { AccessibilityTheme } from "./theme.js";

export interface ThemePanelItem {
  id: string;
  label: string;
  detail: string;
  current?: boolean;
}

/** `/theme` 不带参数时展示的菜单项，`current` 标记当前配色方案。 */
export function themePanelItems(theme: AccessibilityTheme): ThemePanelItem[] {
  return [
    { id: "default", label: "默认", detail: "遵循启动参数和环境设置" },
    { id: "plain", label: "纯文本", detail: "关闭配色、动画与 Emoji" },
    {
      id: "dark",
      label: "深色配色",
      detail: "适合深色终端背景",
      current: theme.palette === "dark",
    },
    {
      id: "light",
      label: "浅色配色",
      detail: "适合浅色终端背景",
      current: theme.palette === "light",
    },
    {
      id: "colorblind",
      label: "色盲友好配色",
      detail: "成功/新增用蓝，警告/错误用橙",
      current: theme.palette === "colorblind",
    },
  ];
}

export class InvalidThemeChoiceError extends Error {
  constructor() {
    super(`用法：/theme [default | plain | ${THEME_PALETTES.join(" | ")}]`);
  }
}

/**
 * 根据 `/theme <id>` 的参数计算新的主题状态，纯函数、不做任何 I/O（持久化由调用方决定要不要做）。
 * `default` 恢复到启动时的主题但保留当前配色方案；`plain` 只关掉 color/motion/emoji，不改配色方案。
 */
export function resolveThemeChoice(
  id: string,
  { theme, initialTheme }: { theme: AccessibilityTheme; initialTheme: AccessibilityTheme },
): AccessibilityTheme {
  if (THEME_PALETTES.includes(id as ThemePalette)) {
    return { ...theme, palette: id as ThemePalette };
  }
  if (id === "plain") return { ...theme, color: false, motion: false, emoji: false };
  if (id === "default") return { ...initialTheme, palette: theme.palette };
  throw new InvalidThemeChoiceError();
}

/** 选择结果提示文案：配色方案切换和 default/plain 切换用不同措辞。 */
export function themeChoiceMessage(id: string): string {
  return THEME_PALETTES.includes(id as ThemePalette) ? `配色方案：${id}` : `终端主题：${id}`;
}

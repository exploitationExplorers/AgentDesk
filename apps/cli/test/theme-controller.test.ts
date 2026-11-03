import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessibilityTheme } from "../src/interactive/theme.js";
import {
  InvalidThemeChoiceError,
  resolveThemeChoice,
  themeChoiceMessage,
  themePanelItems,
} from "../src/interactive/theme-controller.js";

const initialTheme: AccessibilityTheme = {
  interactive: true,
  color: true,
  motion: true,
  emoji: true,
  palette: "dark",
};

test("resolveThemeChoice 切换配色方案只改 palette，不动 color/motion/emoji", () => {
  const next = resolveThemeChoice("light", { theme: initialTheme, initialTheme });
  assert.equal(next.palette, "light");
  assert.equal(next.color, true);
  assert.equal(next.motion, true);
});

test("resolveThemeChoice plain 只关闭 color/motion/emoji，不改配色方案", () => {
  const theme: AccessibilityTheme = { ...initialTheme, palette: "colorblind" };
  const next = resolveThemeChoice("plain", { theme, initialTheme });
  assert.equal(next.color, false);
  assert.equal(next.motion, false);
  assert.equal(next.emoji, false);
  assert.equal(next.palette, "colorblind");
});

test("resolveThemeChoice default 恢复启动时的主题，但保留当前配色方案", () => {
  const plain: AccessibilityTheme = { ...initialTheme, color: false, motion: false };
  const next = resolveThemeChoice("default", {
    theme: { ...plain, palette: "light" },
    initialTheme,
  });
  assert.equal(next.color, true);
  assert.equal(next.motion, true);
  assert.equal(next.palette, "light");
});

test("resolveThemeChoice 未知参数抛出用法提示", () => {
  assert.throws(
    () => resolveThemeChoice("solarized", { theme: initialTheme, initialTheme }),
    InvalidThemeChoiceError,
  );
});

test("themePanelItems 标记当前配色方案", () => {
  const items = themePanelItems({ ...initialTheme, palette: "light" });
  const light = items.find((item) => item.id === "light");
  const dark = items.find((item) => item.id === "dark");
  assert.equal(light?.current, true);
  assert.equal(dark?.current, false);
});

test("themeChoiceMessage 区分配色方案与整体主题的提示文案", () => {
  assert.match(themeChoiceMessage("dark"), /配色方案/);
  assert.match(themeChoiceMessage("plain"), /终端主题/);
  assert.match(themeChoiceMessage("default"), /终端主题/);
});

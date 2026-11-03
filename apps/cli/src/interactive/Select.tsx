import { Box, Text } from "ink";
import { pick } from "./colors.js";
import type { AccessibilityTheme } from "./theme.js";

export interface SelectOption {
  id: string;
  label: string;
  /** 次要信息，淡色展示在 label 之后，例如相对时间、所属分组。 */
  meta?: string;
}

/**
 * Selector 家族的共用展示组件：审批菜单、会话选择器等"从列表里选一项"的交互统一用这个渲染，
 * 保证同一套聚焦指示和配色语言。键盘由调用方统一监听（对齐 CommandPanel 的架构），这里只接收
 * 当前高亮下标渲染。
 */
export default function Select({
  options,
  focusedIndex,
  theme,
}: {
  options: SelectOption[];
  focusedIndex: number;
  theme: AccessibilityTheme;
}) {
  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const focused = index === focusedIndex;
        return (
          <Text key={option.id}>
            <Text color={focused ? pick("suggestion", theme) : undefined}>
              {focused ? "❯ " : "  "}
              {option.label}
            </Text>
            {option.meta ? <Text dimColor> · {option.meta}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

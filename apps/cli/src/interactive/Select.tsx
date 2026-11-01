import { Box, Text } from "ink";
import { pick } from "./colors.js";
import type { AccessibilityTheme } from "./theme.js";

export interface SelectOption {
  id: string;
  label: string;
}

/** 纯展示的方向键选项列表；键盘由调用方统一监听（对齐 CommandPanel 的架构）。 */
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
          <Text key={option.id} color={focused ? pick("suggestion", theme) : undefined}>
            {focused ? "❯ " : "  "}
            {option.label}
          </Text>
        );
      })}
    </Box>
  );
}

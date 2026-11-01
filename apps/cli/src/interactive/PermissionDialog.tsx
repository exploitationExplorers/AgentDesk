import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { pick } from "./colors.js";
import type { AccessibilityTheme } from "./theme.js";

/** 审批弹窗外壳：只画顶部分隔线（不围四边），标题 + 可选副标题 + 任意内容。对齐 Claude Code PermissionDialog。 */
export default function PermissionDialog({
  title,
  subtitle,
  theme,
  children,
}: {
  title: string;
  subtitle?: string;
  theme: AccessibilityTheme;
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={pick("permission", theme)}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Text bold color={pick("permission", theme)}>
          {title}
        </Text>
        {subtitle ? (
          <Text dimColor wrap="truncate-start">
            {subtitle}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {children}
      </Box>
    </Box>
  );
}

import { Box, Text } from "ink";
import type { RiskLevel } from "@agentdesk/shared";
import { pick } from "../colors.js";
import type { AccessibilityTheme } from "../theme.js";
import { stringField } from "./payload.js";

/** 对齐 Claude Code 的 Bash 审批：命令本身作为正文加粗展示，而不是挤在标题里。 */
export default function BashApproval({
  args,
  risk,
  theme,
}: {
  args: unknown;
  risk?: RiskLevel;
  theme: AccessibilityTheme;
}) {
  const command = stringField(args, "command") ?? "";
  const cwd = stringField(args, "cwd");
  return (
    <Box flexDirection="column">
      <Text bold>{command}</Text>
      <Text dimColor>工作目录：{cwd ?? "(默认)"}</Text>
      {risk === "dangerous" ? (
        <Text color={pick("warning", theme)}>此命令可能修改系统状态，请确认后再执行。</Text>
      ) : null}
    </Box>
  );
}

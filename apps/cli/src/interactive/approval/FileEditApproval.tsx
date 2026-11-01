import { Box, Text } from "ink";
import { DiffLines, diffRows } from "../FileDiff.js";
import { pick } from "../colors.js";
import type { AccessibilityTheme } from "../theme.js";

/** 对齐 Claude Code 文件编辑审批里的真实 diff 视图；detail 已是后端生成的统一 diff 文本。 */
export default function FileEditApproval({ detail, theme }: { detail: string; theme: AccessibilityTheme }) {
  const rows = diffRows(detail);
  const additions = rows.filter((row) => row.kind === "add").length;
  const deletions = rows.filter((row) => row.kind === "delete").length;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={pick("success", theme)}>+{additions}</Text>{" "}
        <Text color={pick("error", theme)}>−{deletions}</Text>
        <Text dimColor> 行{additions || deletions ? "" : " · 内容未变化"}</Text>
      </Text>
      <DiffLines rows={rows} theme={theme} />
    </Box>
  );
}

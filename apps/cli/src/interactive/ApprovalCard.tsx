import { Box, Text } from "ink";
import type { ApprovalStep } from "./types.js";

export default function ApprovalCard({
  title,
  detail,
  resolved,
  approved,
}: Pick<ApprovalStep, "title" | "detail" | "resolved" | "approved">) {
  const color = resolved ? "gray" : "yellow";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Text bold color={color}>
        {resolved ? "审批" : "⚠ 需要审批"} · {title}
      </Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
      <Text dimColor>
        {resolved
          ? approved === undefined
            ? "已处理或已结束"
            : approved
              ? "已批准"
              : "已拒绝"
          : "按 y 批准 · 按 n 或 Esc 拒绝"}
      </Text>
    </Box>
  );
}

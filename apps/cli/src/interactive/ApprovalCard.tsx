import { Box, Text } from "ink";
import type { ApprovalStep } from "./types.js";
import ScrollViewport from "./ScrollViewport.js";

export default function ApprovalCard({
  title,
  detail,
  resolved,
  approved,
  maxRows,
}: Pick<ApprovalStep, "title" | "detail" | "resolved" | "approved"> & { maxRows?: number }) {
  const color = resolved ? "gray" : "yellow";
  if (resolved) {
    return (
      <Text dimColor wrap="truncate-end">
        {approved === undefined ? "· 已处理或已结束" : approved ? "✓ 已批准" : "✗ 已拒绝"} ·{" "}
        {title.replace(/\s+/g, " ")}
      </Text>
    );
  }
  if (maxRows !== undefined && !resolved) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        flexShrink={0}
      >
        <Text bold color={color}>
          ⚠ 需要审批
        </Text>
        <ScrollViewport maxRows={Math.max(2, maxRows - 4)} followEnd={false} arrows>
          <Text bold>{title}</Text>
          {detail ? <Text>{detail}</Text> : null}
        </ScrollViewport>
        <Text dimColor wrap="truncate-end">
          按 y 批准 · 按 n 或 Esc 拒绝
        </Text>
      </Box>
    );
  }
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

import { Box, Text } from "ink";

export default function TaskStatusBar({ taskId, status, busy }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        任务 {taskId ?? "（未知）"} · 状态 {status ?? "（未知）"} · {busy ? "执行中" : "已结束"}
        {" · "}o 展开/折叠全部工具 · Ctrl+C 断开（不会取消任务，取消请用 agentdesk cancel）
      </Text>
    </Box>
  );
}

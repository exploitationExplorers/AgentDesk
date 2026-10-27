import { Box, Text } from "ink";

export default function StatusBar({ conversationId, pendingApprovals, busy }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        会话 {conversationId ?? "（尚未开始）"} · {busy ? "执行中" : "空闲"}
        {pendingApprovals > 0 ? ` · 待审批 ${pendingApprovals} 条` : ""}
        {" · o 展开/折叠工具 · Ctrl+C 中断/退出"}
      </Text>
    </Box>
  );
}

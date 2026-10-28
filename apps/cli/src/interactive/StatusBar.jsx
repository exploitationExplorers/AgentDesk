import { Box, Text } from "ink";

export default function StatusBar({ conversationId, pendingApprovals, busy, stepFocusActive }) {
  const hint = stepFocusActive
    ? "步骤导航：↑↓/jk 选择 · Enter/空格 展开折叠 · Esc 或 Tab 返回输入"
    : "o 展开/折叠全部工具 · Tab 聚焦步骤导航 · Ctrl+C 中断/退出";
  return (
    <Box marginTop={1}>
      <Text dimColor>
        会话 {conversationId ?? "（尚未开始）"} · {busy ? "执行中" : "空闲"}
        {pendingApprovals > 0 ? ` · 待审批 ${pendingApprovals} 条` : ""}
        {" · "}
        {hint}
      </Text>
    </Box>
  );
}

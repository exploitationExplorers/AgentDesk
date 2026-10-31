import { Box, Text } from "ink";

export default function StatusBar({
  conversationId,
  pendingApprovals,
  busy,
  stepFocusActive,
  model,
  agent,
}: {
  conversationId: string | null;
  pendingApprovals: number;
  busy: boolean;
  stepFocusActive: boolean;
  model?: string;
  agent?: string;
}) {
  const hint = stepFocusActive
    ? "步骤导航：↑↓/jk 选择 · Enter/空格 展开折叠 · Esc 或 Tab 返回输入"
    : "/ 指令 · Enter 发送 · Esc 中断 · Ctrl+O 展开工具 · Ctrl+C 中断/退出";
  return (
    <Box paddingX={1} flexDirection="column" flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        {busy ? "执行中" : "空闲"} ·{" "}
        {conversationId ? `会话 ${conversationId.slice(0, 8)}` : "新会话"}
        {pendingApprovals > 0 ? ` · 待审批 ${pendingApprovals} 条` : ""}
        {model ? ` · ${model}` : ""}
        {agent ? ` · ${agent}` : ""}
      </Text>
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}

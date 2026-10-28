import { Box, Text } from "ink";
import type { Conversation } from "@agentdesk/shared";

const MAX_TITLE_LENGTH = 40;

function truncateTitle(title: string) {
  const text = title && title.trim() ? title.trim() : "（无标题）";
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH)}…` : text;
}

function formatRelativeTime(iso: string) {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) return "";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`;
  return date.toISOString().slice(0, 10);
}

/**
 * 纯展示组件：交互会话启动时的会话选择器。
 * 键盘导航统一由 App.jsx 的单一 useInput 处理（避免多个 useInput 争抢 raw mode），
 * 这里只接收当前高亮下标渲染。
 */
export default function ConversationPicker({
  conversations,
  selectedIndex,
}: {
  conversations: Conversation[];
  selectedIndex: number;
}) {
  const items = [
    { id: null, label: "新建对话", time: "" },
    ...conversations.map((conversation) => ({
      id: conversation.id,
      label: truncateTitle(conversation.title),
      time: formatRelativeTime(conversation.updatedAt),
    })),
  ];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>选择会话</Text>
      <Text dimColor>↑↓ 或 j/k 选择 · Enter 确认 · Esc 取消并退出</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, index) => {
          const focused = index === selectedIndex;
          return (
            <Box key={item.id ?? "new"}>
              <Text color="cyan">{focused ? "▌" : " "}</Text>
              <Text bold={focused} inverse={focused}>
                {" "}
                {item.label}
              </Text>
              {item.time ? <Text dimColor> · {item.time}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

import { Box, Text } from "ink";

export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  current?: boolean;
}

export interface CommandPanelData {
  title: string;
  lines?: string[];
  items?: MenuItem[];
  onSelect?: (id: string) => void | Promise<void>;
}

export default function CommandPanel({
  panel,
  index,
  limit = 8,
  color = true,
}: {
  panel: CommandPanelData;
  index: number;
  limit?: number;
  color?: boolean;
}) {
  const count = panel.items?.length ?? panel.lines?.length ?? 0;
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), count - limit));
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color={color ? "cyan" : undefined}>
        {panel.title}
      </Text>
      {panel.items
        ? panel.items.slice(start, start + limit).map((item, offset) => (
            <Text
              key={item.id}
              color={color && index === start + offset ? "cyan" : undefined}
              wrap="truncate-end"
            >
              {index === start + offset ? "❯ " : "  "}
              {item.label}
              {item.current ? " ✓" : ""}
              {item.detail ? <Text dimColor>{`  ${item.detail}`}</Text> : null}
            </Text>
          ))
        : panel.lines?.slice(start, start + limit).map((line, offset) => (
            <Text key={start + offset} wrap="truncate-end">
              {line}
            </Text>
          ))}
      {count === 0 ? <Text dimColor>没有匹配的条目。</Text> : null}
      <Text dimColor>
        {panel.items ? "输入筛选 · ↑↓ 选择 · Enter 确认 · Esc 返回" : "↑↓ 滚动 · Enter / Esc 返回"}
        {count > limit ? ` · ${start + 1}–${Math.min(start + limit, count)} / ${count}` : ""}
      </Text>
    </Box>
  );
}

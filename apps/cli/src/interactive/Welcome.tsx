import { Box, Text } from "ink";
import type { AgentName } from "@agentdesk/shared";
import type { AccessibilityTheme } from "./theme.js";

export interface WelcomeProps {
  agent?: AgentName;
  model?: string;
  version?: string;
  cwd?: string;
  theme?: AccessibilityTheme;
}

/** AgentDesk 的像素伙伴：桌面与终端共用薄荷绿机器人形象。 */
export default function Welcome({
  agent = "orchestrator",
  model,
  version = "0.1.0",
  cwd = process.cwd(),
  theme,
}: WelcomeProps) {
  return (
    <Box gap={2} marginTop={1} marginBottom={1} paddingX={1}>
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme?.color ? "#72D9BA" : undefined}>
          {"    ▄▄    \n ▄██████▄ \n █ ▀  ▀ █ \n ▀██▄▄██▀ \n  ▀▀  ▀▀  "}
        </Text>
      </Box>
      <Box flexDirection="column" justifyContent="center" flexGrow={1}>
        <Text>
          <Text bold>AgentDesk</Text>
          <Text dimColor>{`  v${version}`}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {model || "本地 Agent 工作台"}
          {` · ${agent === "code" ? "编码助手" : agent === "orchestrator" ? "总控助手" : agent}`}
        </Text>
        <Text dimColor wrap="truncate-middle">
          {cwd}
        </Text>
        <Text color={theme?.color ? "#72D9BA" : undefined}>一起把想法写成代码。</Text>
      </Box>
    </Box>
  );
}

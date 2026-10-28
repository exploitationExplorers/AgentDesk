import { Box, Text } from "ink";
import StepList from "./StepList.jsx";

const TRIGGER_LABEL = {
  create: "新建",
  followup: "追加指令",
  resume: "重跑",
  continue: "继续",
  delegate: "委派",
};
const STATUS_COLOR = { running: "cyan", succeeded: "green", failed: "red", cancelled: "yellow" };

/**
 * 渲染一次根 Run（一个 Task 生命周期内可能有多条根 Run：create/followup/resume）。
 * Run 事件流本身不携带触发它的那句用户消息（见 packages/shared/src/contracts/task.ts 的
 * run_started 事件形状），因此这里用 agent/trigger/状态作为标题，而不是像 chat 的 TurnView
 * 那样展示"› 用户消息"。
 */
export default function RunView({ run, runsById, expanded, theme, live = false }) {
  const color = STATUS_COLOR[run.runStatus] ?? "cyan";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>
        {"▶ "}
        <Text bold>{run.agent}</Text>
        {` · ${TRIGGER_LABEL[run.trigger] ?? run.trigger}`}
        {run.done ? ` · ${run.runStatus}` : live ? " · 执行中…" : ""}
      </Text>
      <StepList steps={run.steps} expanded={expanded} theme={theme} runsById={runsById} />
      {run.text ? <Text>{run.text}</Text> : live ? <Text dimColor>思考中…</Text> : null}
      {run.error ? <Text color="red">{run.error}</Text> : null}
    </Box>
  );
}

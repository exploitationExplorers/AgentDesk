import { Box, Text } from "ink";
import StepList from "./StepList.jsx";

export default function LiveTurnView({
  live,
  expanded,
  theme,
  stepFocusActive,
  focusedStepId,
  focusOverrides,
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="blue">
        {"› "}
        {live.userMessage}
      </Text>
      <StepList
        steps={live.steps}
        expanded={expanded}
        theme={theme}
        stepFocusActive={stepFocusActive}
        focusedStepId={focusedStepId}
        focusOverrides={focusOverrides}
      />
      {live.text ? <Text>{live.text}</Text> : <Text dimColor>思考中…</Text>}
      {live.error ? <Text color="red">{live.error}</Text> : null}
    </Box>
  );
}

import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown.mjs";
import StepList from "./StepList.jsx";

export default function TurnView({ turn, expanded, theme }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="blue">
        {"› "}
        {turn.userMessage}
      </Text>
      <StepList steps={turn.steps} expanded={expanded} theme={theme} />
      {turn.text ? <Text>{renderMarkdown(turn.text, theme)}</Text> : null}
      {turn.error ? <Text color="red">{turn.error}</Text> : null}
    </Box>
  );
}

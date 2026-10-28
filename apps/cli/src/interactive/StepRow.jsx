import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SPINNER_FRAMES } from "./theme.mjs";

function useSpinner(active, motion) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || !motion) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(timer);
  }, [active, motion]);
  return SPINNER_FRAMES[frame];
}

function preview(value) {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function StepRow({ step, expanded, theme, focused = false }) {
  const pending = step.kind === "tool" && !step.done;
  const spinner = useSpinner(pending, theme.motion);
  if (step.kind === "route") {
    return (
      <Box>
        <Text color="magenta">↳ </Text>
        <Text bold>{step.agent}</Text>
        <Text dimColor> {step.reason}</Text>
      </Box>
    );
  }
  const mark = pending ? spinner : step.isError ? "✗" : "✓";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{focused ? "▌" : " "}</Text>
        <Text color={pending ? "cyan" : step.isError ? "red" : "green"}>{mark} </Text>
        <Text bold inverse={focused}>
          {step.name}
        </Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{preview(step.args)}</Text>
          {step.done ? (
            <Text dimColor={!step.isError} color={step.isError ? "red" : undefined}>
              {preview(step.result)}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

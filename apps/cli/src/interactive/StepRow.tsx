import { useEffect, useState, type Ref } from "react";
import { Box, Text, type DOMElement } from "ink";
import { SPINNER_FRAMES } from "./theme.js";
import { toolLabel } from "./tool-label.js";
import FileDiff, { resultFileChange } from "./FileDiff.js";
import type { RouteStep, StepViewProps, ToolStep } from "./types.js";

function useSpinner(active: boolean, motion: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || !motion) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(timer);
  }, [active, motion]);
  return SPINNER_FRAMES[frame];
}

function preview(value: unknown) {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function StepRow({
  step,
  expanded,
  theme,
  focused = false,
  ref,
}: StepViewProps & { step: ToolStep | RouteStep; focused?: boolean; ref?: Ref<DOMElement> }) {
  const pending = step.kind === "tool" && !step.done && !step.change;
  const spinner = useSpinner(pending, theme.motion);
  if (step.kind === "route") {
    return (
      <Box flexDirection="column">
        <Text wrap={expanded ? "wrap" : "truncate-end"}>
          <Text color="magenta">↳ </Text>
          <Text bold>{step.agent}</Text>
          <Text dimColor> {step.reason}</Text>
        </Text>
      </Box>
    );
  }
  const mark = pending ? spinner : step.isError ? "✗" : "✓";
  const change = step.change ?? resultFileChange(step.result);
  const label = toolLabel(step.name, step.args);
  return (
    <Box ref={ref} flexDirection="column">
      <Box>
        <Text color="cyan">{focused ? "▌" : " "}</Text>
        <Text color={pending ? "cyan" : step.isError ? "red" : "green"}>{mark} </Text>
        <Text bold inverse={focused} wrap="truncate-end">
          {label.action}
          {label.target ? ` ${label.target}` : ""}
        </Text>
      </Box>
      {!step.isError && change ? <FileDiff change={change} theme={theme} /> : null}
      {expanded && !change ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{preview(step.args)}</Text>
          {step.output ? <Text dimColor>{step.output.slice(-1600)}</Text> : null}
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

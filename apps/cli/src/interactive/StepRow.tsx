import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SPINNER_FRAMES } from "./theme.js";
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

function fileChangeSummary(result: unknown): { additions: number; deletions: number } | null {
  if (typeof result !== "object" || result === null || !("change" in result)) return null;
  const change = result.change;
  if (
    typeof change !== "object" ||
    change === null ||
    !("additions" in change) ||
    !("deletions" in change)
  )
    return null;
  return typeof change.additions === "number" && typeof change.deletions === "number"
    ? { additions: change.additions, deletions: change.deletions }
    : null;
}

function pathFromArgs(args: unknown): string {
  return typeof args === "object" &&
    args !== null &&
    "path" in args &&
    typeof args.path === "string"
    ? args.path
    : "";
}

export default function StepRow({
  step,
  expanded,
  theme,
  focused = false,
}: StepViewProps & { step: ToolStep | RouteStep; focused?: boolean }) {
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
  const change = fileChangeSummary(step.result);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{focused ? "▌" : " "}</Text>
        <Text color={pending ? "cyan" : step.isError ? "red" : "green"}>{mark} </Text>
        <Text bold inverse={focused}>
          {step.name}
        </Text>
      </Box>
      {step.done && !step.isError && change ? (
        <Box paddingLeft={3}>
          <Text dimColor>{pathFromArgs(step.args)} </Text>
          <Text color="green">+{change.additions}</Text>
          <Text color="red"> −{change.deletions}</Text>
        </Box>
      ) : null}
      {expanded ? (
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

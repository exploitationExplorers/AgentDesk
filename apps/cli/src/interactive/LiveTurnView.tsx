import { useRef } from "react";
import { Box, Text, type DOMElement } from "ink";
import StepList from "./StepList.js";
import type { StepViewProps, Turn } from "./types.js";
import ApprovalCard from "./ApprovalCard.js";
import ScrollViewport from "./ScrollViewport.js";

export default function LiveTurnView({
  live,
  expanded,
  theme,
  stepFocusActive,
  focusedStepId,
  focusOverrides,
  maxRows = 17,
}: StepViewProps & { live: Turn; maxRows?: number }) {
  const focusedRef = useRef<DOMElement>(null);
  const waiting = !live.text && !live.steps.some((step) => step.kind === "tool" && !step.done);
  const approval = live.steps.find((step) => step.kind === "approval" && !step.resolved);
  if (approval?.kind === "approval") {
    return <ApprovalCard key={approval.approvalId} {...approval} maxRows={maxRows} />;
  }
  return (
    <ScrollViewport
      maxRows={maxRows}
      focusedRef={focusedRef}
      focusKey={stepFocusActive ? focusedStepId : null}
    >
      <Box flexDirection="column" flexShrink={0}>
        <StepList
          steps={live.steps}
          expanded={expanded}
          theme={theme}
          stepFocusActive={stepFocusActive}
          focusedStepId={focusedStepId}
          focusOverrides={focusOverrides}
          focusedRef={focusedRef}
        />
        {live.text ? <Text>{live.text}</Text> : waiting ? <Text dimColor>思考中…</Text> : null}
        {live.error ? <Text color="red">{live.error}</Text> : null}
      </Box>
    </ScrollViewport>
  );
}

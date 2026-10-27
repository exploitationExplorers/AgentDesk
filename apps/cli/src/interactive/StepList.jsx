import { Box } from "ink";
import ApprovalCard from "./ApprovalCard.jsx";
import StepRow from "./StepRow.jsx";

export default function StepList({ steps, expanded, theme }) {
  if (!steps.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {steps.map((step, index) => {
        if (step.kind === "approval")
          return <ApprovalCard key={`approval-${step.approvalId}`} {...step} />;
        const key = step.kind === "tool" ? `tool-${step.id}` : `route-${index}`;
        return <StepRow key={key} step={step} expanded={expanded} theme={theme} />;
      })}
    </Box>
  );
}

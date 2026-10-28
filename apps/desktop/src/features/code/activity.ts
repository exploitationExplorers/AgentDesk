import type { FileChange, RunEventRecord } from "@agentdesk/shared";

export interface CodeStep {
  key: string;
  runId: string;
  agent: string;
  name: string;
  args: unknown;
  result?: unknown;
  status: "running" | "done" | "error" | "cancelled";
  createdAt: string;
  output: string;
}
export interface CodeChange {
  key: string;
  runId: string;
  change: FileChange;
  createdAt: string;
}

export function projectActivity(records: RunEventRecord[]) {
  const steps: CodeStep[] = [];
  const changes: CodeChange[] = [];
  const byId = new Map<string, CodeStep>();
  const textByRun = new Map<string, string>();
  const approvalIds = new Set<string>();
  for (const record of records) {
    const event = record.event;
    if (event.type === "tool_call") {
      const key = `${record.runId}:${event.id}`;
      if (byId.has(key)) continue;
      const step: CodeStep = {
        key,
        runId: record.runId,
        agent: event.agent,
        name: event.name,
        args: event.args,
        status: "running",
        createdAt: record.createdAt,
        output: "",
      };
      byId.set(key, step);
      steps.push(step);
    } else if (event.type === "tool_result") {
      const step = byId.get(`${record.runId}:${event.id}`);
      const commandFailed =
        event.result &&
        typeof event.result === "object" &&
        "exitCode" in event.result &&
        event.result.exitCode !== 0;
      if (step) {
        step.status = event.isError || commandFailed ? "error" : "done";
        step.result = event.result;
      }
    } else if (event.type === "tool_output") {
      const step = byId.get(`${record.runId}:${event.toolCallId}`);
      if (step) step.output = (step.output + event.delta).slice(-80_000);
    } else if (event.type === "file_change") {
      changes.push({
        key: `${record.runId}:${record.seq}`,
        runId: record.runId,
        change: event.change,
        createdAt: record.createdAt,
      });
    } else if (event.type === "text_delta") {
      textByRun.set(record.runId, (textByRun.get(record.runId) ?? "") + event.delta);
    } else if (event.type === "approval_required") approvalIds.add(event.approvalId);
    else if (event.type === "run_ended") {
      for (const step of steps)
        if (step.runId === record.runId && step.status === "running")
          step.status = event.status === "cancelled" ? "cancelled" : "error";
    }
  }
  return { steps, changes, textByRun, approvalIds };
}

export function stepHint(step: CodeStep): string {
  const args =
    step.args && typeof step.args === "object" ? (step.args as Record<string, unknown>) : {};
  return String(
    args.path ?? args.command ?? args.query ?? args.pattern ?? args.task ?? args.project ?? "",
  );
}

export function outputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "output" in value) return String(value.output);
  return JSON.stringify(value, null, 2);
}

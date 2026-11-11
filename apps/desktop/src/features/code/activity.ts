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

export interface CodeActivity {
  steps: CodeStep[];
  changes: CodeChange[];
  textByRun: Map<string, string>;
  approvalIds: Set<string>;
}

/** 每批只复制发生变化的集合；已经交给 React 的快照保持不可变。 */
export function createActivityProjector() {
  let activity: CodeActivity = {
    steps: [],
    changes: [],
    textByRun: new Map(),
    approvalIds: new Set(),
  };
  const byId = new Map<string, number>();

  function append(records: readonly RunEventRecord[]): CodeActivity {
    let { steps, changes, textByRun, approvalIds } = activity;
    const editedSteps = new Set<number>();
    const editStep = (index: number): CodeStep => {
      if (steps === activity.steps) steps = steps.slice();
      if (!editedSteps.has(index)) {
        steps[index] = { ...steps[index]! };
        editedSteps.add(index);
      }
      return steps[index]!;
    };
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
        if (steps === activity.steps) steps = steps.slice();
        byId.set(key, steps.length);
        editedSteps.add(steps.length);
        steps.push(step);
      } else if (event.type === "tool_result") {
        const index = byId.get(`${record.runId}:${event.id}`);
        const commandFailed =
          event.result &&
          typeof event.result === "object" &&
          "exitCode" in event.result &&
          event.result.exitCode !== 0;
        if (index !== undefined) {
          const step = editStep(index);
          step.status = event.isError || commandFailed ? "error" : "done";
          step.result = event.result;
        }
      } else if (event.type === "tool_output") {
        const index = byId.get(`${record.runId}:${event.toolCallId}`);
        if (index !== undefined) {
          const step = editStep(index);
          step.output = (step.output + event.delta).slice(-80_000);
        }
      } else if (event.type === "file_change") {
        if (changes === activity.changes) changes = changes.slice();
        changes.push({
          key: `${record.runId}:${record.seq}`,
          runId: record.runId,
          change: event.change,
          createdAt: record.createdAt,
        });
      } else if (event.type === "text_delta") {
        if (textByRun === activity.textByRun) textByRun = new Map(textByRun);
        textByRun.set(record.runId, (textByRun.get(record.runId) ?? "") + event.delta);
      } else if (event.type === "approval_required") {
        if (!approvalIds.has(event.approvalId)) {
          if (approvalIds === activity.approvalIds) approvalIds = new Set(approvalIds);
          approvalIds.add(event.approvalId);
        }
      } else if (event.type === "run_ended") {
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index]!;
          if (step.runId === record.runId && step.status === "running") {
            editStep(index).status = event.status === "cancelled" ? "cancelled" : "error";
          }
        }
      }
    }
    activity = { steps, changes, textByRun, approvalIds };
    return activity;
  }

  return { append, getSnapshot: () => activity };
}

export function projectActivity(records: readonly RunEventRecord[]): CodeActivity {
  return createActivityProjector().append(records);
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

import type { ApprovalStep, RouteStep, Step, ToolStep, Turn } from "./types.js";
import { splitLiveSteps } from "./tool-label.js";

export type TranscriptItem =
  | { kind: "welcome" }
  | { kind: "user"; text: string }
  | { kind: "step"; step: ToolStep | RouteStep }
  | { kind: "approval"; step: ApprovalStep }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string };

function isRow(step: Step): step is ToolStep | RouteStep {
  return step.kind === "tool" || step.kind === "route";
}

function turnItems(turn: Turn, archiveAll: boolean): TranscriptItem[] {
  const steps = archiveAll ? turn.steps : splitLiveSteps(turn.steps).archived;
  const items: TranscriptItem[] = [{ kind: "user", text: turn.userMessage }];
  for (const step of steps) {
    if (isRow(step)) items.push({ kind: "step", step });
    else if (step.kind === "approval") items.push({ kind: "approval", step });
  }
  if (!archiveAll) return items;
  if (turn.text) items.push({ kind: "answer", text: turn.text });
  if (turn.error) items.push({ kind: "error", text: turn.error });
  return items;
}

/** 只追加、不改写已输出的行，避免整段对话被终端反复重绘。 */
export function transcriptItems(turns: Turn[], live: Turn | null): TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: "welcome" }];
  for (const turn of turns) items.push(...turnItems(turn, true));
  if (live) items.push(...turnItems(live, false));
  return items;
}

export function visibleLiveTurn(turn: Turn): Turn {
  return { ...turn, steps: splitLiveSteps(turn.steps).visible };
}

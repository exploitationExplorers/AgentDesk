import type { AgentName, ChatMessage, RunNode, Step } from "@agentdesk/shared";
import type { AccessibilityTheme } from "./theme.js";

// Step/ToolStep/RouteStep/ApprovalStep/DelegateStep/NoteStep/RunNode 已搬到
// packages/shared/src/task-session.ts（桌面端工作台也复用同一套），这里整体 re-export，
// CLI 内部 import 不用跟着改。
export type {
  ApprovalStep,
  DelegateStep,
  NoteStep,
  RouteStep,
  RunNode,
  Step,
  ToolStep,
} from "@agentdesk/shared";

export interface Turn {
  userMessage: string;
  text: string;
  agent: AgentName | null;
  steps: Step[];
  error: string | null;
}

export type HistoryMessage = Pick<ChatMessage, "role" | "content"> & Partial<ChatMessage>;

export interface StepViewProps {
  expanded: boolean;
  theme: AccessibilityTheme;
  stepFocusActive?: boolean;
  focusedStepId?: string | null;
  focusOverrides?: ReadonlySet<string>;
  runsById?: Record<string, RunNode>;
}

import type {
  AgentName,
  ApprovalReason,
  ChatMessage,
  FileChange,
  RiskLevel,
  RunStatus,
  RunTrigger,
  ToolCallRecord,
} from "@agentdesk/shared";
import type { AccessibilityTheme } from "./theme.js";

export interface ToolStep extends Pick<
  ToolCallRecord,
  "id" | "name" | "args" | "result" | "isError"
> {
  kind: "tool";
  agent: AgentName | null;
  done: boolean;
  output?: string;
  change?: FileChange;
}

export interface RouteStep {
  kind: "route";
  agent: AgentName;
  reason: string;
}

export interface ApprovalStep {
  kind: "approval";
  approvalId: string;
  title: string;
  detail: string;
  risk?: RiskLevel;
  payload?: unknown;
  reason?: ApprovalReason;
  resolved: boolean;
  approved?: boolean;
}

export interface DelegateStep {
  kind: "delegate";
  runId: string;
  agent: AgentName;
  trigger: RunTrigger;
}

/** 规则放行 / Bash 分类器自动放行留下的一行提示，不影响工具调用本身的展示。 */
export interface NoteStep {
  kind: "note";
  text: string;
  source: "rule" | "classifier";
}

export type Step = ToolStep | RouteStep | ApprovalStep | DelegateStep | NoteStep;

export interface Turn {
  userMessage: string;
  text: string;
  agent: AgentName | null;
  steps: Step[];
  error: string | null;
}

export type HistoryMessage = Pick<ChatMessage, "role" | "content"> & Partial<ChatMessage>;

export interface RunNode {
  runId: string;
  parentRunId: string | null;
  agent: AgentName;
  trigger: RunTrigger;
  activeAgent: AgentName | null;
  text: string;
  steps: Step[];
  error: string | null;
  runStatus: RunStatus;
  done: boolean;
}

export interface StepViewProps {
  expanded: boolean;
  theme: AccessibilityTheme;
  stepFocusActive?: boolean;
  focusedStepId?: string | null;
  focusOverrides?: ReadonlySet<string>;
  runsById?: Record<string, RunNode>;
}

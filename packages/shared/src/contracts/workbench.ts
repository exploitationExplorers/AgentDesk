import type { AgentStreamEvent, Conversation } from "./chat";
import type { ConversationContextStatus } from "./context";
import type { Artifact, Run, Task } from "./task";

export interface SessionWorkbench {
  conversation: Conversation;
  workspace: string | null;
  task: Task | null;
  runs: Run[];
  artifacts: Artifact[];
  usedTools: string[];
  pendingApprovals: number;
  pendingApprovalIds?: string[];
  activity: "running" | "compacting" | null;
  context: ConversationContextStatus | null;
  contextError: string | null;
  latestUsage: Extract<AgentStreamEvent, { type: "model_usage" }> | null;
  lastCompaction: Extract<AgentStreamEvent, { type: "context_compaction" }> | null;
}

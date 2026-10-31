import { z } from "zod";
import { AgentName, ModelSelection } from "./provider";
import type { FileChange } from "./code";

export const ToolCallRecord = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  agent: AgentName.optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const ChatMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  agent: AgentName.nullable(),
  toolCalls: z.array(ToolCallRecord),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const Conversation = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

/** SSE 事件：对话和工作流执行共用的流式事件协议。 */
export type AgentStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "route"; agent: AgentName; reason: string }
  | { type: "agent_start"; agent: AgentName }
  | { type: "text_delta"; agent: AgentName; delta: string }
  | { type: "tool_call"; agent: AgentName; id: string; name: string; args: unknown }
  | { type: "tool_result"; agent: AgentName; id: string; result: unknown; isError: boolean }
  | { type: "file_change"; agent: AgentName; toolCallId: string; change: FileChange }
  | { type: "tool_output"; agent: AgentName; toolCallId: string; delta: string }
  | { type: "approval_required"; approvalId: string; title: string; detail: string }
  | { type: "agent_end"; agent: AgentName }
  | { type: "error"; message: string }
  | { type: "done"; messageId: string };

export const ChatRequest = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1),
  agent: AgentName.optional(),
  workspace: z.string().max(4096).optional(),
  modelSelection: ModelSelection.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

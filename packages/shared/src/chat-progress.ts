import type { AgentName } from "./contracts/provider";
import type { AgentStreamEvent, ChatDisplayBlock } from "./contracts/chat";
import type { TaskStreamEvent } from "./contracts/task";

export interface ChatProgress {
  agent: AgentName | null;
  phase: "thinking" | "writing" | "working" | "waiting" | "idle";
  blocks: ChatDisplayBlock[];
  newText: boolean;
  status: string | null;
}

export function emptyChatProgress(): ChatProgress {
  return { agent: null, phase: "thinking", blocks: [], newText: true, status: null };
}

/** 仅投影公开阶段文本与工具状态，参数、返回值、私有推理均不进入展示记录。 */
export function reduceChatProgress(
  state: ChatProgress,
  event: AgentStreamEvent | TaskStreamEvent,
): ChatProgress {
  if (event.type === "agent_start" && !state.agent) return { ...state, agent: event.agent };
  if (event.type === "response_start")
    return { ...state, phase: "thinking", newText: true, status: null };
  if (event.type === "response_status")
    return { ...state, phase: "thinking", status: event.message };
  if (event.type === "text_delta") {
    if (state.agent && state.agent !== event.agent) return state;
    const blocks = [...state.blocks];
    const last = blocks.at(-1);
    if (!state.newText && last?.kind === "text")
      blocks[blocks.length - 1] = { kind: "text", text: last.text + event.delta };
    else blocks.push({ kind: "text", text: event.delta });
    return { ...state, blocks, phase: "writing", newText: false, status: null };
  }
  if (event.type === "tool_call")
    return {
      ...state,
      phase: "working",
      status: null,
      newText: true,
      blocks: [
        ...state.blocks,
        { kind: "activity", id: event.id, name: event.name, agent: event.agent, status: "running" },
      ],
    };
  if (event.type === "tool_result") {
    const blocks: ChatDisplayBlock[] = state.blocks.map((block) =>
      block.kind === "activity" && block.id === event.id && block.agent === event.agent
        ? { ...block, status: event.isError ? "failed" : "complete" }
        : block,
    );
    return {
      ...state,
      status: null,
      phase: blocks.some((block) => block.kind === "activity" && block.status === "running")
        ? "working"
        : "thinking",
      blocks,
    };
  }
  if (event.type === "approval_required") return { ...state, phase: "waiting" };
  if (
    (event.type === "agent_end" && event.agent === state.agent) ||
    event.type === "error" ||
    event.type === "done"
  )
    return {
      ...state,
      phase: "idle",
      blocks: state.blocks.map((block) =>
        block.kind === "activity" && block.status === "running"
          ? { ...block, status: "failed" }
          : block,
      ),
    };
  if (
    event.type === "presentation_status" ||
    event.type === "presentation_slide" ||
    event.type === "document_preview"
  )
    return { ...state, phase: "working" };
  return state;
}

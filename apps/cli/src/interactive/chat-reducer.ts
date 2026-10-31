import type { AgentStreamEvent, Approval } from "@agentdesk/shared";
import type { HistoryMessage, Turn } from "./types.js";

export interface ChatSession {
  conversationId: string | null;
  turns: Turn[];
  live: Turn | null;
  pendingApprovals: Approval[];
  status: "idle" | "streaming" | "awaiting-approval";
  error: string | null;
}

export type ChatAction =
  | AgentStreamEvent
  | { type: "SUBMIT"; message: string }
  | { type: "APPROVAL_ANSWERED"; approvalId: string; approved: boolean }
  | { type: "TURN_SETTLED" | "ABORT_TURN" }
  | { type: "APPROVALS_POLLED"; approvals: Approval[] }
  | { type: "LOCAL_RESULT"; command: string; text: string }
  | { type: "RESET"; conversationId?: string; messages?: HistoryMessage[] }
  | { type: "RESUME"; conversationId: string | null; messages: HistoryMessage[] };

/**
 * 交互式会话的纯状态机，与 Ink 完全解耦，可直接单测。
 * Action 与后端 AgentStreamEvent（见 packages/shared/src/contracts/chat.ts）1:1 对应，
 * 外加 SUBMIT/APPROVAL_ANSWERED/TURN_SETTLED/ABORT_TURN/APPROVALS_POLLED/RESUME。
 */

export function createInitialSession(): ChatSession {
  return {
    conversationId: null,
    turns: [],
    live: null,
    pendingApprovals: [],
    status: "idle",
    error: null,
  };
}

function emptyLiveTurn(userMessage: string): Turn {
  return { userMessage, text: "", agent: null, steps: [], error: null };
}

/** 把 `/conversations/:id/messages` 的历史记录还原成 Static 区可渲染的已完成轮次。 */
export function turnsFromMessages(messages: HistoryMessage[]): Turn[] {
  const turns: Turn[] = [];
  let pendingUser: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message.content;
      continue;
    }
    turns.push({
      userMessage: pendingUser ?? "",
      text: message.content,
      agent: message.agent ?? null,
      steps: (message.toolCalls ?? []).map((call) => ({
        kind: "tool",
        id: call.id,
        agent: call.agent ?? message.agent ?? null,
        name: call.name,
        args: call.args,
        result: call.result,
        isError: call.isError,
        done: true,
      })),
      error: null,
    });
    pendingUser = null;
  }
  if (pendingUser !== null) turns.push(emptyLiveTurn(pendingUser));
  return turns;
}

export function sessionReducer(session: ChatSession, action: ChatAction): ChatSession {
  switch (action.type) {
    case "LOCAL_RESULT":
      return {
        ...session,
        turns: [...session.turns, { ...emptyLiveTurn(action.command), text: action.text }],
      };
    case "RESET":
      return {
        ...createInitialSession(),
        conversationId: action.conversationId ?? null,
        turns: turnsFromMessages(action.messages ?? []),
      };
    case "SUBMIT":
      return { ...session, status: "streaming", error: null, live: emptyLiveTurn(action.message) };

    case "conversation":
      return { ...session, conversationId: action.conversationId };

    case "route": {
      if (!session.live) return session;
      return {
        ...session,
        live: {
          ...session.live,
          steps: [
            ...session.live.steps,
            { kind: "route", agent: action.agent, reason: action.reason },
          ],
        },
      };
    }

    case "agent_start": {
      if (!session.live) return session;
      return { ...session, live: { ...session.live, agent: session.live.agent ?? action.agent } };
    }

    case "text_delta": {
      if (!session.live) return session;
      // 只有当前活跃 agent（总控或用户直选的 agent）的文本计入可见回答；子 agent 输出走它自己的 tool step。
      if (session.live.agent && action.agent !== session.live.agent) return session;
      return { ...session, live: { ...session.live, text: session.live.text + action.delta } };
    }

    case "tool_call": {
      if (!session.live) return session;
      return {
        ...session,
        live: {
          ...session.live,
          steps: [
            ...session.live.steps,
            {
              kind: "tool",
              id: action.id,
              agent: action.agent,
              name: action.name,
              args: action.args,
              done: false,
            },
          ],
        },
      };
    }

    case "tool_output": {
      if (!session.live) return session;
      return {
        ...session,
        live: {
          ...session.live,
          steps: session.live.steps.map((step) =>
            step.kind === "tool" && step.id === action.toolCallId
              ? { ...step, output: ((step.output ?? "") + action.delta).slice(-8000) }
              : step,
          ),
        },
      };
    }

    case "file_change": {
      if (!session.live) return session;
      return {
        ...session,
        live: {
          ...session.live,
          steps: session.live.steps.map((step) =>
            step.kind === "tool" && step.id === action.toolCallId
              ? { ...step, change: action.change }
              : step,
          ),
        },
      };
    }

    case "tool_result": {
      if (!session.live) return session;
      return {
        ...session,
        live: {
          ...session.live,
          steps: session.live.steps.map((step) =>
            step.kind === "tool" && step.id === action.id
              ? { ...step, result: action.result, isError: action.isError, done: true }
              : step,
          ),
        },
      };
    }

    case "approval_required": {
      if (!session.live) return session;
      return {
        ...session,
        status: "awaiting-approval",
        live: {
          ...session.live,
          steps: [
            ...session.live.steps,
            {
              kind: "approval",
              approvalId: action.approvalId,
              title: action.title,
              detail: action.detail,
              resolved: false,
            },
          ],
        },
      };
    }

    // 本地动作：用户在 ApprovalCard 上按 y/n 后立即反馈，真正的 POST /approvals/:id 由会话入口发起。
    case "APPROVAL_ANSWERED": {
      if (!session.live) return session;
      return {
        ...session,
        status: "streaming",
        live: {
          ...session.live,
          steps: session.live.steps.map((step) =>
            step.kind === "approval" && step.approvalId === action.approvalId
              ? { ...step, resolved: true, approved: action.approved }
              : step,
          ),
        },
      };
    }

    case "agent_end":
      return session;

    case "error": {
      if (!session.live) return { ...session, error: action.message };
      return { ...session, live: { ...session.live, error: action.message } };
    }

    // 真正落入历史发生在 TURN_SETTLED；done 事件本身不改变可见状态。
    case "done":
      return session;

    case "TURN_SETTLED": {
      if (!session.live) return { ...session, status: "idle" };
      return { ...session, status: "idle", turns: [...session.turns, session.live], live: null };
    }

    case "ABORT_TURN": {
      if (!session.live) return { ...session, status: "idle" };
      return {
        ...session,
        status: "idle",
        turns: [...session.turns, { ...session.live, error: session.live.error ?? "已中断" }],
        live: null,
      };
    }

    case "APPROVALS_POLLED":
      return { ...session, pendingApprovals: action.approvals };

    case "RESUME":
      return {
        ...session,
        conversationId: action.conversationId,
        turns: [...session.turns, ...turnsFromMessages(action.messages)],
      };

    default:
      return session;
  }
}

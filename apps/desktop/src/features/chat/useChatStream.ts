import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { AgentName, AgentStreamEvent } from "@agentdesk/shared";
import { api } from "../../lib/api";
import { useUi } from "../../stores/ui";

function sessionIdFromBrowserTool(name: string, args: unknown, result?: unknown): string | null {
  if (!name.startsWith("browser.")) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.sessionId === "string" && a.sessionId) return a.sessionId;
  const r = result as Record<string, unknown> | undefined;
  if (r && typeof r.id === "string") return r.id;
  if (r && typeof r.sessionId === "string") return r.sessionId;
  return null;
}

export type LiveStep =
  | { kind: "route"; agent: AgentName; reason: string }
  | {
      kind: "tool";
      id: string;
      agent: AgentName;
      name: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      done: boolean;
    }
  | { kind: "approval"; approvalId: string; title: string; detail: string };

export interface LiveTurn {
  userMessage: string;
  text: string;
  agent: AgentName | null;
  steps: LiveStep[];
  error: string | null;
}

/** 管理一轮对话的流式状态；结束后刷新持久化消息并清空临时状态。 */
export function useChatStream(onConversation: (id: string) => void) {
  const queryClient = useQueryClient();
  const openBrowserPanel = useUi((s) => s.openBrowserPanel);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const controller = useRef<AbortController | null>(null);

  const send = useCallback(
    async (message: string, conversationId: string | undefined, agent?: AgentName) => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      let convId = conversationId;
      setLive({ userMessage: message, text: "", agent: null, steps: [], error: null });

      const apply = (event: AgentStreamEvent) => {
        if (event.type === "tool_call") {
          const sid = sessionIdFromBrowserTool(event.name, event.args);
          if (sid) openBrowserPanel(sid);
        }
        if (event.type === "tool_result") {
          const sid = sessionIdFromBrowserTool("browser.x", undefined, event.result);
          // 从对应 tool_call 名判断：结果里常有 id/sessionId
          const fromResult =
            event.result &&
            typeof event.result === "object" &&
            ("id" in (event.result as object) ||
              "sessionId" in (event.result as object) ||
              "shotUrl" in (event.result as object));
          if (fromResult) {
            const r = event.result as Record<string, unknown>;
            const id =
              (typeof r.sessionId === "string" && r.sessionId) ||
              (typeof r.id === "string" && r.id) ||
              sid;
            if (id && (r.shotUrl || r.url || r.open !== undefined)) openBrowserPanel(String(id));
          }
        }

        setLive((prev) => {
          if (!prev) return prev;
          switch (event.type) {
            case "conversation":
              return prev;
            case "route":
              return {
                ...prev,
                steps: [...prev.steps, { kind: "route", agent: event.agent, reason: event.reason }],
              };
            case "agent_start":
              return { ...prev, agent: prev.agent ?? event.agent };
            case "text_delta":
              // 只把总控（或用户直选的 Agent）的文本作为最终回答；子 Agent 输出体现在工具结果里
              if (prev.agent && event.agent !== prev.agent) return prev;
              return { ...prev, text: prev.text + event.delta };
            case "tool_call":
              return {
                ...prev,
                steps: [
                  ...prev.steps,
                  {
                    kind: "tool",
                    id: event.id,
                    agent: event.agent,
                    name: event.name,
                    args: event.args,
                    done: false,
                  },
                ],
              };
            case "tool_result":
              return {
                ...prev,
                steps: prev.steps.map((s) =>
                  s.kind === "tool" && s.id === event.id
                    ? { ...s, result: event.result, isError: event.isError, done: true }
                    : s,
                ),
              };
            case "approval_required":
              return {
                ...prev,
                steps: [
                  ...prev.steps,
                  {
                    kind: "approval",
                    approvalId: event.approvalId,
                    title: event.title,
                    detail: event.detail,
                  },
                ],
              };
            case "error":
              return { ...prev, error: event.message };
            default:
              return prev;
          }
        });
      };

      try {
        await api.chat(
          { conversationId, message, agent },
          (event) => {
            if (event.type === "conversation" && event.conversationId !== convId) {
              convId = event.conversationId;
              onConversation(event.conversationId);
            }
            apply(event);
          },
          ctrl.signal,
        );
      } catch (error) {
        if (!ctrl.signal.aborted)
          setLive((p) =>
            p ? { ...p, error: error instanceof Error ? error.message : String(error) } : p,
          );
      } finally {
        if (convId) await queryClient.invalidateQueries({ queryKey: ["messages", convId] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        if (controller.current === ctrl) {
          controller.current = null;
          setLive(null);
        }
      }
    },
    [onConversation, queryClient, openBrowserPanel],
  );

  const stop = useCallback(() => controller.current?.abort(), []);
  return { live, send, stop, streaming: live !== null };
}

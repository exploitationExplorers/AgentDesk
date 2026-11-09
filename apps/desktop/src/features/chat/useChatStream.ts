import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentName, AgentStreamEvent } from "@agentdesk/shared";
import { api } from "../../lib/api";
import { http } from "../../lib/http";
import {
  runFailureMessage,
  emptyChatProgress,
  reduceChatProgress,
  type ChatProgress,
} from "@agentdesk/shared";
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
  | {
      kind: "approval";
      approvalId: string;
      title: string;
      detail: string;
      question: boolean;
      options: string[];
      index?: number;
      total?: number;
    };

export interface LiveTurn {
  conversationId?: string;
  startedAt: number;
  messageId?: string;
  userMessage: string;
  text: string;
  agent: AgentName | null;
  steps: LiveStep[];
  error: string | null;
  progress: ChatProgress;
}

/** 管理一轮对话的流式状态；结束后刷新持久化消息并清空临时状态。 */
export function useChatStream(
  onConversation: (id: string) => void,
  displayedConversationId?: string,
) {
  const queryClient = useQueryClient();
  const openBrowserPanel = useUi((s) => s.openBrowserPanel);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const controller = useRef<AbortController | null>(null);
  const activeConversation = useRef<string | undefined>(undefined);
  const stopRequested = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  const send = useCallback(
    async (
      message: string,
      conversationId: string | undefined,
      agent?: AgentName,
      workspace?: string,
    ) => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      let convId = conversationId;
      let connectionFailed = false;
      activeConversation.current = conversationId;
      stopRequested.current = false;
      setLive({
        conversationId,
        startedAt: Date.now(),
        userMessage: message,
        text: "",
        agent: null,
        steps: [],
        error: null,
        progress: emptyChatProgress(),
      });

      const apply = (event: AgentStreamEvent) => {
        if (
          ["model_usage", "context_compaction", "approval_required", "done"].includes(event.type)
        ) {
          void queryClient.invalidateQueries({ queryKey: ["session-workbench", convId] });
        }
        if (event.type === "approval_required") {
          void queryClient.invalidateQueries({ queryKey: ["approvals", "pending"] });
        }
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
          prev = { ...prev, progress: reduceChatProgress(prev.progress, event) };
          switch (event.type) {
            case "conversation":
              return { ...prev, conversationId: event.conversationId };
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
                    question:
                      typeof event.payload === "object" &&
                      event.payload !== null &&
                      "kind" in event.payload &&
                      event.payload.kind === "question",
                    options:
                      typeof event.payload === "object" &&
                      event.payload !== null &&
                      "options" in event.payload &&
                      Array.isArray(event.payload.options)
                        ? event.payload.options.filter(
                            (option): option is string => typeof option === "string",
                          )
                        : [],
                    index:
                      typeof event.payload === "object" &&
                      event.payload !== null &&
                      "index" in event.payload &&
                      typeof event.payload.index === "number"
                        ? event.payload.index
                        : undefined,
                    total:
                      typeof event.payload === "object" &&
                      event.payload !== null &&
                      "total" in event.payload &&
                      typeof event.payload.total === "number"
                        ? event.payload.total
                        : undefined,
                  },
                ],
              };
            case "error":
              return { ...prev, error: runFailureMessage(event.message) };
            case "done":
              return { ...prev, messageId: event.messageId };
            default:
              return prev;
          }
        });
      };

      try {
        await api.chat(
          { conversationId, message, agent, workspace },
          (event) => {
            if (event.type === "conversation" && event.conversationId !== convId) {
              convId = event.conversationId;
              activeConversation.current = convId;
              if (stopRequested.current)
                void http.post(`/conversations/${encodeURIComponent(convId)}/stop`);
              onConversation(event.conversationId);
            }
            apply(event);
          },
          ctrl.signal,
        );
      } catch (error) {
        if (!ctrl.signal.aborted) {
          connectionFailed = true;
          setLive((p) =>
            p
              ? {
                  ...p,
                  progress: { ...p.progress, phase: "idle" },
                  error: runFailureMessage(error instanceof Error ? error.message : String(error)),
                }
              : p,
          );
        }
      } finally {
        if (convId) await queryClient.invalidateQueries({ queryKey: ["messages", convId] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["session-workbench", convId] });
        if (controller.current === ctrl) {
          controller.current = null;
          if (!connectionFailed) setLive(null);
        }
      }
    },
    [onConversation, queryClient, openBrowserPanel],
  );

  const stop = useCallback(async () => {
    stopRequested.current = true;
    const id = activeConversation.current;
    if (id) await http.post(`/conversations/${encodeURIComponent(id)}/stop`);
  }, []);
  const visible = live && live.conversationId === displayedConversationId ? live : null;
  const clearConnectionError = useCallback(
    () => setLive((current) => (current?.error ? null : current)),
    [],
  );
  return {
    live: visible,
    send,
    stop,
    clearConnectionError,
    streaming: visible !== null && visible.error === null,
  };
}

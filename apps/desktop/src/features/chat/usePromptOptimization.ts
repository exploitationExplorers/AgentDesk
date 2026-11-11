import { useEffect, useRef, useState } from "react";
import { MAX_PROMPT_OPTIMIZATION_CHARS } from "@agentdesk/shared";
import type { AgentName, ModelSelection } from "@agentdesk/shared";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";
import { EMPTY_CHAT_DRAFT, useChatDrafts } from "./drafts";

interface OptimizationSnapshot {
  scopeId: string;
  contextKey: string;
  revision: number;
  sourceText: string;
  requestId: number;
  model: string;
}

export type PromptOptimizationState = {
  snapshot: OptimizationSnapshot;
} & (
  | { status: "pending" }
  | { status: "ready"; optimizedText: string }
  | { status: "error"; message: string }
);

export function usePromptOptimization({
  scopeId,
  projectId,
  agent,
  modelSelection,
  unavailable,
}: {
  scopeId: string;
  projectId?: string | null;
  agent: AgentName;
  modelSelection?: ModelSelection;
  unavailable: boolean;
}) {
  const draft = useChatDrafts((state) => state.drafts[scopeId] ?? EMPTY_CHAT_DRAFT);
  const contextKey = JSON.stringify([scopeId, projectId, agent, modelSelection, unavailable]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const sequence = useRef(0);
  const active = useRef<{ id: number; controller: AbortController } | null>(null);
  const [state, setState] = useState<PromptOptimizationState | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    setState(null);
    setPreviewOpen(false);
    return () => {
      active.current?.controller.abort();
      active.current = null;
    };
  }, [contextKey]);

  const result = state?.snapshot.contextKey === contextKey ? state : null;
  const cancel = () => {
    active.current?.controller.abort();
    active.current = null;
    setState(null);
    setPreviewOpen(false);
  };

  const start = async () => {
    if (unavailable) return;
    const current = useChatDrafts.getState().drafts[scopeId] ?? EMPTY_CHAT_DRAFT;
    if (!current.text.trim()) return;
    if (!modelSelection) {
      toast("请先配置可用模型", {
        description: "点击输入框的模型配置，选择已启用并配置 API Key 的模型。",
        tone: "warning",
      });
      return;
    }
    if (current.text.length > MAX_PROMPT_OPTIMIZATION_CHARS) {
      toast(`提示词最多支持 ${MAX_PROMPT_OPTIMIZATION_CHARS.toLocaleString()} 个字符`, {
        description: "请缩短内容后重试，原文会完整保留。",
        tone: "warning",
      });
      return;
    }
    active.current?.controller.abort();
    const request = { id: ++sequence.current, controller: new AbortController() };
    active.current = request;
    const snapshot: OptimizationSnapshot = {
      scopeId,
      contextKey,
      revision: current.revision,
      sourceText: current.text,
      requestId: request.id,
      model: modelSelection.model,
    };
    setState({ snapshot, status: "pending" });
    setPreviewOpen(false);
    const isCurrent = () =>
      active.current === request &&
      currentContext.current === contextKey &&
      !request.controller.signal.aborted;
    try {
      const response = await api.optimizePrompt(
        { text: snapshot.sourceText, agent, modelSelection },
        request.controller.signal,
      );
      if (!isCurrent()) return;
      setState({ snapshot, status: "ready", optimizedText: response.optimizedText });
      const latest = useChatDrafts.getState().drafts[scopeId] ?? EMPTY_CHAT_DRAFT;
      // 继续编辑时不抢走输入焦点，由用户主动打开旧候选。
      setPreviewOpen(latest.revision === snapshot.revision);
    } catch (error) {
      if (!isCurrent()) return;
      setState({
        snapshot,
        status: "error",
        message: error instanceof Error ? error.message : "优化失败，请稍后重试。",
      });
    } finally {
      if (active.current === request) active.current = null;
    }
  };

  const canApply = result?.status === "ready" && result.snapshot.revision === draft.revision;
  const apply = () => {
    if (!result || result.status !== "ready" || !canApply) return false;
    const applied = useChatDrafts
      .getState()
      .apply(scopeId, result.snapshot.revision, result.optimizedText);
    if (applied) cancel();
    return applied;
  };

  return {
    state: result,
    previewOpen: previewOpen && result?.status === "ready",
    setPreviewOpen,
    canApply,
    start,
    cancel,
    apply,
  };
}

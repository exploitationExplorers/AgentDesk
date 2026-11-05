import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentStreamEvent, RunEventRecord } from "@agentdesk/shared";
import { emptyChatProgress, reduceChatProgress, type ChatProgress } from "@agentdesk/shared";
import { subscribe } from "../../lib/http";
import type { LiveStep } from "./useChatStream";

/** 从持久化事件恢复当前轮，页面刷新或断线不会重新执行任务。 */
export function useTaskObservation(
  conversationId: string | undefined,
  taskId: string | undefined,
  runId: string | null | undefined,
  active: boolean,
) {
  const client = useQueryClient();
  type Slide = Extract<AgentStreamEvent, { type: "presentation_slide" }>;
  type Observation = {
    runId: string;
    text: string;
    steps: LiveStep[];
    slides: Slide[];
    progress: string | null;
    presentation: boolean;
    presentationId?: string;
    presentationTitle?: string;
    document: Extract<AgentStreamEvent, { type: "document_preview" }> | null;
    timeline: ChatProgress;
  };
  const [state, setState] = useState<Observation | null>(null);
  useEffect(() => {
    if (!taskId || !runId || !active) return;
    const seen = new Set<number>();
    let snapshot: Observation = {
      runId,
      text: "",
      steps: [],
      slides: [],
      progress: null,
      presentation: false,
      document: null,
      timeline: emptyChatProgress(),
    };
    return subscribe<RunEventRecord>(
      `/tasks/${encodeURIComponent(taskId)}/stream`,
      (record) => {
        if (seen.has(record.seq)) return;
        seen.add(record.seq);
        if (record.runId !== runId && record.parentRunId !== runId) return;
        const event = record.event;
        if (["artifact_ready", "approval_required", "run_ended", "done"].includes(event.type)) {
          void client.invalidateQueries({ queryKey: ["session-workbench", conversationId] });
          void client.invalidateQueries({ queryKey: ["approvals"] });
        }
        if (event.type === "run_ended" || event.type === "done")
          void client.invalidateQueries({ queryKey: ["messages", conversationId] });
        snapshot = (() => {
          const current = { ...snapshot, timeline: reduceChatProgress(snapshot.timeline, event) };
          if (event.type === "document_preview")
            return { ...current, document: event, presentation: false };
          if (event.type === "text_delta" && record.runId === runId)
            return { ...current, text: current.text + event.delta };
          if (event.type === "presentation_status")
            return {
              ...current,
              progress: event.message,
              presentation: true,
              document: null,
              presentationId: event.presentationId ?? current.presentationId,
              presentationTitle: event.deckTitle ?? current.presentationTitle,
              slides:
                event.phase === "starting" ||
                (event.presentationId && event.presentationId !== current.presentationId)
                  ? []
                  : current.slides,
            };
          if (event.type === "presentation_slide")
            return {
              ...current,
              presentation: true,
              document: null,
              presentationId: event.presentationId ?? current.presentationId,
              presentationTitle: event.deckTitle,
              progress: `正在制作第 ${event.index} / ${event.total} 页`,
              slides: [
                ...current.slides.filter(
                  (slide) =>
                    slide.index !== event.index &&
                    slide.deckTitle === event.deckTitle &&
                    slide.presentationId === event.presentationId,
                ),
                event,
              ].sort((a, b) => a.index - b.index),
            };
          if (event.type === "tool_call")
            return {
              ...current,
              presentation: current.presentation || event.name.startsWith("presentations."),
              steps: [
                ...current.steps,
                {
                  kind: "tool",
                  id: event.id,
                  name: event.name,
                  args: event.args,
                  agent: event.agent,
                  done: false,
                },
              ],
            };
          if (event.type === "tool_result")
            return {
              ...current,
              steps: current.steps.map((step) =>
                step.kind === "tool" && step.id === event.id && step.agent === event.agent
                  ? { ...step, done: true, isError: event.isError }
                  : step,
              ),
            };
          return current;
        })();
        setState(snapshot);
      },
      { isFinal: (record) => record.event.type === "run_ended" && record.runId === runId },
    );
  }, [client, conversationId, taskId, runId, active]);
  return active && state?.runId === runId ? state : null;
}

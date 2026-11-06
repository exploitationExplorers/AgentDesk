import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { Composer } from "../chat/Composer";
import { clearPendingEvent, preparePendingEvent, readPendingEvent } from "./pending";

export function AutomationFollowup({
  taskId,
  conversationId,
}: {
  taskId: string;
  conversationId: string;
}) {
  const client = useQueryClient();
  const scope = `followup:${taskId}`;
  const [pending, setPending] = useState(() => readPendingEvent(scope));
  const followup = useMutation({
    mutationFn: async (message: string) => {
      const request = preparePendingEvent(scope, message);
      setPending(request);
      await api.followupAutomationTask(taskId, { message, eventId: request.eventId });
      return request;
    },
    onSuccess: (request) => {
      clearPendingEvent(scope, request.eventId);
      setPending(null);
      void client.invalidateQueries({ queryKey: ["session-workbench", conversationId] });
      void client.invalidateQueries({ queryKey: ["messages", conversationId] });
      void client.invalidateQueries({ queryKey: ["automation-tasks"] });
    },
  });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">继续描述修改要求，沿用此会话和已有成果。</p>
      {pending?.message ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{pending.message}</p>
          <Button
            size="sm"
            disabled={followup.isPending}
            onClick={() => followup.mutate(pending.message!)}
          >
            {followup.isPending ? "正在提交…" : "重试上次修改请求"}
          </Button>
        </div>
      ) : followup.isSuccess ? (
        <p role="status" className="text-sm text-muted">
          修改要求已提交，正在继续处理。
        </p>
      ) : (
        <Composer
          onSend={(message) => followup.mutate(message)}
          onStop={() => {}}
          streaming={false}
          disabled={followup.isPending}
          agent="orchestrator"
        />
      )}
      {followup.error ? (
        <p role="alert" className="text-xs text-danger">
          {followup.error.message}
        </p>
      ) : null}
    </div>
  );
}

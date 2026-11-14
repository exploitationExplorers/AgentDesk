import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CornerUpLeft, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import type { Approval, CollaborationMember, CollaborationMessage } from "@agentdesk/shared";
import { Markdown } from "../../components/Markdown";
import { api } from "../../lib/api";
import { http } from "../../lib/http";
import { SavedSteps } from "../chat/Steps";
import { CollaborationAvatar } from "./CollaborationAvatar";
import { collaborationError, collaborationRoleLabels } from "./CollaborationDialogs";

function evidenceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function CollaborationMessageRow({
  message,
  messages,
  members,
  onReply,
}: {
  message: CollaborationMessage;
  messages: CollaborationMessage[];
  members: CollaborationMember[];
  onReply: (message: CollaborationMessage) => void;
}) {
  const owner = message.author.kind === "owner";
  const reply = message.replyToId
    ? messages.find((item) => item.id === message.replyToId)
    : undefined;
  const time = new Date(message.createdAt);
  if (message.author.kind === "system")
    return <div className="cc-system-message">{message.content}</div>;
  return (
    <article
      id={`cc-message-${message.id}`}
      className={`cc-message ${owner ? "cc-message-owner" : ""}`}
      data-message-id={message.id}
    >
      <CollaborationAvatar agent={owner ? undefined : message.author.agent} />
      <div className="cc-message-content">
        <div className="cc-who">
          <b>{owner ? "你" : message.author.name}</b>
          <span>
            {Number.isNaN(time.getTime())
              ? ""
              : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.role ? <span>{collaborationRoleLabels[message.role]}</span> : null}
        </div>
        <div className="cc-bubble">
          {reply ? (
            <button
              className="cc-quote"
              type="button"
              onClick={() =>
                document.getElementById(`cc-message-${reply.id}`)?.scrollIntoView({
                  block: "center",
                  behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? "instant"
                    : "smooth",
                })
              }
            >
              <b>{reply.author.name}</b>
              <span>{reply.content.slice(0, 160)}</span>
            </button>
          ) : null}
          {message.content ? (
            <Markdown>{message.content}</Markdown>
          ) : message.status === "streaming" ? (
            <span className="cc-writing">正在整理思路…</span>
          ) : null}
          {message.mentionIds.length ? (
            <div className="cc-message-mentions">
              {message.mentionIds.map((id) => (
                <span key={id}>@{members.find((member) => member.id === id)?.name ?? "成员"}</span>
              ))}
            </div>
          ) : null}
        </div>
        {message.toolCalls.length ? (
          <details className="cc-tools">
            <summary>{message.toolCalls.length} 步处理记录</summary>
            <SavedSteps calls={message.toolCalls} />
          </details>
        ) : null}
        {message.evidence.length ? (
          <div className="cc-evidence">
            {message.evidence.map((item, index) => {
              const url = evidenceUrl(item.url);
              return url ? (
                <a
                  key={`${item.url}-${index}`}
                  href={url.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={12} />
                  {url.hostname}
                  <span>{index + 1}</span>
                </a>
              ) : null;
            })}
          </div>
        ) : null}
        <div className="cc-message-foot">
          {message.status === "failed" ? (
            <span className="cc-error">这条回复未完成</span>
          ) : message.status === "cancelled" ? (
            <span>已停止，保留已有内容</span>
          ) : message.status === "streaming" ? (
            <span>正在回复</span>
          ) : null}
          <button type="button" className="cc-reply-button" onClick={() => onReply(message)}>
            <CornerUpLeft size={12} />
            引用
          </button>
        </div>
      </div>
    </article>
  );
}

export function CollaborationApproval({
  approval,
  roomId,
}: {
  approval: Approval;
  roomId: string;
}) {
  const client = useQueryClient();
  const [answer, setAnswer] = useState("");
  const question = approval.kind === "question";
  const resolve = useMutation({
    mutationFn: (approved: boolean) =>
      question
        ? http.post<Approval>(`/approvals/${encodeURIComponent(approval.id)}/answer`, {
            text: approved ? answer.trim() : "跳过",
          })
        : api.resolveApproval(approval.id, approved),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["collaboration", "room", roomId] });
      void client.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  return (
    <section className="cc-approval" aria-label={question ? "回答问题" : "确认操作"}>
      <h3>{approval.title}</h3>
      <p>{approval.detail}</p>
      {question ? (
        <label className="cc-field">
          你的回答
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={3}
            placeholder="补充信息，让讨论继续。"
          />
        </label>
      ) : null}
      {resolve.error ? (
        <p className="cc-error" role="alert">
          {collaborationError(resolve.error)}
        </p>
      ) : null}
      <div className="cc-decision-buttons">
        <button
          disabled={resolve.isPending || (question && !answer.trim())}
          onClick={() => resolve.mutate(true)}
        >
          {resolve.isPending ? <Loader2 className="cc-spin" size={14} /> : <Check size={14} />}
          {question ? "发送回答" : "允许这次操作"}
        </button>
        <button disabled={resolve.isPending} onClick={() => resolve.mutate(false)}>
          {question ? "跳过" : "暂不执行"}
        </button>
      </div>
    </section>
  );
}

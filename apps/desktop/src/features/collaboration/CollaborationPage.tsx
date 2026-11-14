import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CollaborationMessage,
  CollaborationRoomDetail,
  CollaborationStatus,
} from "@agentdesk/shared";
import { collaborationApi } from "./collaboration-api";
import { CollaborationAvatar } from "./CollaborationAvatar";
import {
  AddCollaborationMember,
  CollaborationMembers,
  CreateCollaborationRoom,
  collaborationError,
  collaborationRoleLabels,
} from "./CollaborationDialogs";
import { CollaborationApproval, CollaborationMessageRow } from "./CollaborationMessages";
import "./collaboration.css";

const statusLabels: Record<CollaborationStatus, string> = {
  idle: "准备好了",
  running: "正在讨论",
  waiting_approval: "等待你的确认",
  awaiting_decision: "等你拍板",
  accepted: "已采纳结论",
  cancelled: "已停止",
  interrupted: "讨论已中断",
  failed: "讨论未完成",
};

type RoomAction = {
  kind: "discuss" | "message" | "stop" | "agree" | "continue";
  roomId: string;
  requestId: string;
  content?: string;
  mentionIds?: string[];
  replyToId?: string;
};

export function CollaborationPage() {
  const { room: roomId } = useSearch({ strict: false }) as { room?: string };
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState<"chats" | "members">("chats");
  const [modal, setModal] = useState<"add" | "create" | "members" | null>(null);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<CollaborationMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileMain, setMobileMain] = useState(Boolean(roomId));
  const [sendMode, setSendMode] = useState<"discuss" | "message">("discuss");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const sources = useQuery({
    queryKey: ["collaboration", "sources"],
    queryFn: collaborationApi.sources,
    staleTime: 15_000,
  });
  const members = useQuery({
    queryKey: ["collaboration", "members"],
    queryFn: collaborationApi.members,
    refetchInterval: 10_000,
  });
  const rooms = useQuery({
    queryKey: ["collaboration", "rooms"],
    queryFn: collaborationApi.rooms,
    refetchInterval: 5_000,
  });
  const detail = useQuery({
    queryKey: ["collaboration", "room", roomId],
    queryFn: ({ signal }) => collaborationApi.detail(roomId!, signal),
    enabled: Boolean(roomId),
    refetchInterval: (query) =>
      ["running", "waiting_approval"].includes(query.state.data?.room.status ?? "") ? 700 : 3_000,
  });
  const room = detail.data?.room;
  const roomMembers = detail.data?.members ?? [];
  const allMembers = members.data ?? [];
  const active = room?.status === "running" || room?.status === "waiting_approval";
  const sameRoundRetry = room
    ? ["failed", "cancelled", "interrupted"].includes(room.status)
    : false;
  const remainingRounds = room ? room.round < room.maxRounds || sameRoundRetry : false;
  const configured = roomMembers.every((member) => member.available);
  const activeMember = roomMembers.find((member) => member.id === room?.activeMemberId);
  const action = useMutation({
    mutationFn: (input: RoomAction) => {
      const { roomId: id, requestId, content, mentionIds, replyToId } = input;
      if (input.kind === "stop") return collaborationApi.stop(id);
      if (input.kind === "agree" || input.kind === "continue")
        return collaborationApi.decide(id, {
          requestId,
          action: input.kind,
          ...(content ? { content } : {}),
        });
      return collaborationApi[input.kind](id, {
        requestId,
        ...(content ? { content } : {}),
        ...(mentionIds?.length ? { mentionIds } : {}),
        ...(replyToId ? { replyToId } : {}),
      });
    },
    onSuccess: (data, input) => {
      client.setQueryData<CollaborationRoomDetail>(["collaboration", "room", data.room.id], data);
      void client.invalidateQueries({ queryKey: ["collaboration", "rooms"] });
      if (input.kind === "message" || input.kind === "discuss") {
        setDraft((current) => (current.trim() === input.content ? "" : current));
        setMentions([]);
        setReplyTo(null);
      }
    },
  });
  const busy = action.isPending;
  const currentError = action.variables?.roomId === roomId ? action.error : null;
  useEffect(() => {
    setDraft("");
    setMentions([]);
    setReplyTo(null);
    setMenuOpen(false);
    setMentionOpen(false);
    setMobileMain(Boolean(roomId));
    nearBottom.current = true;
  }, [roomId]);
  useEffect(() => {
    if (nearBottom.current && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [detail.data?.messages, detail.data?.pendingApprovals, room?.status]);
  const selectRoom = (id: string) => {
    setMobileMain(true);
    void navigate({ to: "/collaboration", search: { room: id } });
  };
  const perform = (kind: RoomAction["kind"], content?: string) => {
    if (!roomId || busy) return;
    nearBottom.current = true;
    const mentioned = [
      ...new Set([
        ...mentions,
        ...roomMembers
          .filter((member) => content?.includes(`@${member.name}`))
          .map((member) => member.id),
      ]),
    ];
    action.mutate({
      kind,
      roomId,
      requestId: crypto.randomUUID(),
      ...(content?.trim() ? { content: content.trim() } : {}),
      mentionIds: mentioned,
      replyToId: replyTo?.id,
    });
  };
  const submitMessage = () => {
    if (!draft.trim() || !roomId || busy) return;
    perform(active || sendMode === "message" ? "message" : "discuss", draft);
  };
  const toggleMention = (id: string) =>
    setMentions((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  const queryError = sources.error ?? members.error ?? rooms.error;
  const loading = sources.isPending || members.isPending || rooms.isPending;
  const startDisabled = busy || active || !remainingRounds || !configured;
  const canSend =
    Boolean(draft.trim()) &&
    !busy &&
    (active || sendMode === "message" || (remainingRounds && configured));
  return (
    <div className="collaboration-page">
      <div className="cc-ambient" aria-hidden="true" />
      <header className="cc-nav">
        <Link to="/welcome" className="cc-logo">
          <img className="cc-logo-mark" src="/reference/icon.svg" alt="" />
          <span>AgentDesk</span>
        </Link>
        <div className="cc-nav-right">
          <Link to="/team" className="cc-workbench-link">
            团队开发
            <ChevronRight size={13} />
          </Link>
          <Link to="/" search={{}} className="cc-workbench-link">
            工作台
            <ChevronRight size={13} />
          </Link>
          <Link className="cc-owner-avatar" to="/settings" search={{}} aria-label="账号与设置">
            你
          </Link>
        </div>
      </header>
      <main className={`cc-workspace ${mobileMain ? "cc-show-main" : ""}`}>
        <aside className="cc-rail" aria-label="Agent 导航">
          <button
            className="cc-rail-item cc-mine"
            onClick={() => {
              setTab("chats");
              setMobileMain(false);
            }}
          >
            <CollaborationAvatar />
            <b>我</b>
          </button>
          <div className="cc-rail-members">
            {allMembers.slice(0, 3).map((member) => (
              <button
                key={member.id}
                className="cc-rail-item"
                onClick={() => {
                  setTab("members");
                  setMobileMain(false);
                }}
                aria-label={`查看成员 ${member.name}`}
              >
                <CollaborationAvatar agent={member.agent} />
                <span>{member.name}</span>
              </button>
            ))}
          </div>
          <button className="cc-rail-item" onClick={() => setModal("add")} disabled={!sources.data}>
            <span className="cc-rail-add">
              <Plus size={23} />
            </span>
            <span>添加成员</span>
          </button>
          <Link
            to="/settings"
            search={{ tab: "providers" }}
            className="cc-rail-item cc-rail-bottom"
          >
            <span className="cc-settings-icon">
              <Settings2 size={21} />
            </span>
            <span>模型设置</span>
          </Link>
        </aside>
        <aside className="cc-sidebar">
          <div className="cc-profile">
            <CollaborationAvatar />
            <div>
              <b>我的 Agent</b>
              <span>它们讨论，你拍板。</span>
            </div>
            <button
              className="cc-circle-button"
              onClick={() => setModal("add")}
              aria-label="添加成员"
              disabled={!sources.data}
            >
              <Plus size={18} />
            </button>
          </div>
          <div className="cc-segmented" role="tablist" aria-label="聊天与成员">
            <button
              role="tab"
              aria-selected={tab === "chats"}
              className={tab === "chats" ? "is-selected" : ""}
              onClick={() => setTab("chats")}
            >
              聊天
            </button>
            <button
              role="tab"
              aria-selected={tab === "members"}
              className={tab === "members" ? "is-selected" : ""}
              onClick={() => setTab("members")}
            >
              成员
            </button>
          </div>
          {queryError ? (
            <div className="cc-sidebar-error" role="alert">
              <p>{collaborationError(queryError)}</p>
              <button
                className="cc-text-button"
                onClick={() => {
                  void sources.refetch();
                  void members.refetch();
                  void rooms.refetch();
                }}
              >
                <RefreshCw size={13} />
                重新加载
              </button>
            </div>
          ) : null}
          <div className="cc-sidebar-scroll">
            {tab === "chats" ? (
              <>
                <button
                  className="cc-outline-button"
                  onClick={() =>
                    setModal(
                      allMembers.filter((member) => member.available).length >= 2
                        ? "create"
                        : "add",
                    )
                  }
                  disabled={loading}
                >
                  <Plus size={18} />
                  建个群
                </button>
                {loading ? (
                  <div className="cc-list-skeleton" aria-label="正在加载群聊">
                    {[0, 1, 2].map((index) => (
                      <div key={index}>
                        <i />
                        <span>
                          <i />
                          <i />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : rooms.data?.length ? (
                  rooms.data.map((item) => (
                    <button
                      className={`cc-room-item ${roomId === item.id ? "is-selected" : ""}`}
                      key={item.id}
                      onClick={() => selectRoom(item.id)}
                    >
                      <span className="cc-room-icon">
                        <Users size={21} />
                      </span>
                      <span>
                        <b>{item.name}</b>
                        <small>
                          {statusLabels[item.status]} · {item.participants.length} 个 Agent
                        </small>
                      </span>
                      {item.status === "running" ? <i className="cc-running-dot" /> : null}
                    </button>
                  ))
                ) : (
                  <div className="cc-sidebar-empty">
                    <p>你的群聊会显示在这里。</p>
                    <span>先添加成员，再建群分工。</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  className="cc-outline-button"
                  onClick={() => setModal("add")}
                  disabled={!sources.data}
                >
                  <Plus size={18} />
                  添加成员
                </button>
                {allMembers.map((member) => (
                  <button
                    className="cc-member-item"
                    key={member.id}
                    onClick={() =>
                      setModal(
                        allMembers.filter((item) => item.available).length >= 2 ? "create" : "add",
                      )
                    }
                  >
                    <CollaborationAvatar agent={member.agent} />
                    <span>
                      <b>{member.name}</b>
                      <small>
                        {member.available
                          ? member.modelSelection.model
                          : (member.unavailableReason ?? "模型尚未配置")}
                      </small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                ))}
                {!allMembers.length ? (
                  <div className="cc-sidebar-empty">
                    <p>把你的 Agent 加进来。</p>
                    <span>每位成员可以使用不同的模型。</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
        <section className="cc-main" aria-label="协作聊天">
          {roomId ? (
            detail.isPending ? (
              <div className="cc-empty-state">
                <Loader2 className="cc-spin" size={28} />
                <p>正在打开群聊…</p>
              </div>
            ) : detail.error ? (
              <div className="cc-empty-state">
                <h1>暂时无法打开这个群</h1>
                <p role="alert">{collaborationError(detail.error)}</p>
                <button className="cc-primary cc-fit" onClick={() => void detail.refetch()}>
                  重新加载
                </button>
                <button
                  className="cc-text-button cc-mobile-only"
                  onClick={() => setMobileMain(false)}
                >
                  返回聊天列表
                </button>
              </div>
            ) : room && detail.data ? (
              <>
                <header className="cc-chat-head">
                  <button
                    className="cc-mobile-back"
                    aria-label="返回聊天列表"
                    onClick={() => setMobileMain(false)}
                  >
                    <ArrowLeft size={21} />
                  </button>
                  <div className="cc-chat-heading">
                    <h1>{room.name}</h1>
                    <p>
                      <span role="status" className={`cc-status cc-status-${room.status}`}>
                        {statusLabels[room.status]}
                      </span>
                      <span>
                        {" "}
                        · {room.participants.length} 个 Agent · 第 {room.round}/{room.maxRounds} 轮
                      </span>
                    </p>
                  </div>
                  <div className="cc-chat-tools">
                    <div className="cc-avatar-stack" aria-hidden="true">
                      {roomMembers.map((member) => (
                        <CollaborationAvatar key={member.id} agent={member.agent} />
                      ))}
                    </div>
                    <button
                      className="cc-more-button"
                      aria-label="群设置"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen((open) => !open)}
                    >
                      <MoreHorizontal size={23} />
                    </button>
                  </div>
                  {menuOpen ? (
                    <div className="cc-group-menu">
                      <button
                        onClick={() => {
                          setModal("members");
                          setMenuOpen(false);
                        }}
                      >
                        成员与分工
                      </button>
                      <button
                        onClick={() => {
                          void detail.refetch();
                          setMenuOpen(false);
                        }}
                      >
                        刷新讨论
                      </button>
                      {active ? (
                        <button
                          onClick={() => {
                            perform("stop");
                            setMenuOpen(false);
                          }}
                        >
                          停止讨论
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </header>
                <div
                  className="cc-chat-body"
                  ref={bodyRef}
                  onScroll={() => {
                    const body = bodyRef.current;
                    if (body)
                      nearBottom.current =
                        body.scrollHeight - body.scrollTop - body.clientHeight < 100;
                  }}
                >
                  <div className="cc-message-list">
                    <div className="cc-topic">
                      <span>这次一起做</span>
                      <p>{room.topic}</p>
                    </div>
                    {detail.data.messages.length ? (
                      detail.data.messages.map((message) => (
                        <CollaborationMessageRow
                          key={message.id}
                          message={message}
                          messages={detail.data.messages}
                          members={roomMembers}
                          onReply={(item) => {
                            setReplyTo(item);
                            inputRef.current?.focus();
                          }}
                        />
                      ))
                    ) : (
                      <div className="cc-chat-intro">
                        <div className="cc-agent-pile">
                          {roomMembers.map((member) => (
                            <CollaborationAvatar key={member.id} agent={member.agent} />
                          ))}
                        </div>
                        <h2>分好了工，开始吧。</h2>
                        <p>
                          调研者找资料，核对者查来源。
                          <br />
                          你可以补充问题，或直接开始讨论。
                        </p>
                        <button
                          className="cc-primary cc-fit"
                          disabled={startDisabled}
                          onClick={() => perform("discuss")}
                        >
                          <MessageCircle size={17} />
                          开始讨论
                        </button>
                      </div>
                    )}
                    {active && activeMember ? (
                      <div
                        className="cc-typing"
                        aria-label={`${activeMember.name}正在${room.phase ? collaborationRoleLabels[room.phase] : "讨论"}`}
                      >
                        <CollaborationAvatar agent={activeMember.agent} />
                        <div className="cc-typing-copy">
                          <span>
                            {activeMember.name} ·{" "}
                            {room.phase ? collaborationRoleLabels[room.phase] : "正在思考"}
                          </span>
                          <div className="cc-dots">
                            <i />
                            <i />
                            <i />
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {detail.data.pendingApprovals.map((approval) => (
                      <CollaborationApproval
                        key={approval.id}
                        approval={approval}
                        roomId={room.id}
                      />
                    ))}
                    {room.status === "awaiting_decision" ? (
                      <section className="cc-decision" aria-label="由你拍板">
                        <h2>讨论到这里，由你拍板。</h2>
                        <p>采纳这份结论，还是让它们再核对一轮？</p>
                        <div className="cc-decision-buttons">
                          <button disabled={busy} onClick={() => perform("agree")}>
                            <Check size={15} />
                            同意
                          </button>
                          <button
                            disabled={busy || !remainingRounds || !configured}
                            onClick={() => perform("continue", draft || undefined)}
                          >
                            再想想
                          </button>
                        </div>
                        {!remainingRounds ? (
                          <small>
                            已完成本群的 {room.maxRounds} 轮讨论。你仍可以补充消息，或建新群继续。
                          </small>
                        ) : null}
                      </section>
                    ) : null}
                    {room.status === "accepted" ? (
                      <div className="cc-accepted">
                        <Check size={17} />
                        已采纳结论。讨论记录和来源都保存在这个群里。
                      </div>
                    ) : null}
                    {["failed", "cancelled", "interrupted"].includes(room.status) ? (
                      <section className="cc-run-error" aria-label="讨论状态">
                        <b>{statusLabels[room.status]}</b>
                        <p>{room.error ?? "已经保留现有的讨论内容。你可以补充说明后继续。"}</p>
                        {remainingRounds ? (
                          <button
                            disabled={busy || !configured}
                            className="cc-text-button"
                            onClick={() => perform("discuss", draft || undefined)}
                          >
                            <RefreshCw size={14} />
                            重试讨论
                          </button>
                        ) : (
                          <p>已用完本群的讨论轮数，可以建立新群继续。</p>
                        )}
                      </section>
                    ) : null}
                    {!configured ? (
                      <div className="cc-run-error">
                        <p>有成员的模型配置已不可用，请先检查模型服务。</p>
                        <Link
                          to="/settings"
                          search={{ tab: "providers" }}
                          className="cc-text-button"
                        >
                          打开模型设置
                          <ChevronRight size={13} />
                        </Link>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="cc-composer-wrap">
                  {currentError ? (
                    <div className="cc-action-error" role="alert">
                      <span>{collaborationError(currentError)}</span>
                      <button
                        onClick={() => action.variables && action.mutate(action.variables)}
                        disabled={busy}
                      >
                        重试
                      </button>
                    </div>
                  ) : null}
                  {replyTo ? (
                    <div className="cc-composer-reply">
                      <span>
                        回复 {replyTo.author.name}：{replyTo.content.slice(0, 80)}
                      </span>
                      <button aria-label="取消引用" onClick={() => setReplyTo(null)}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : null}
                  {mentions.length ? (
                    <div className="cc-composer-mentions">
                      {mentions.map((id) => (
                        <button key={id} onClick={() => toggleMention(id)}>
                          @{roomMembers.find((member) => member.id === id)?.name}
                          <X size={11} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <form
                    className="cc-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitMessage();
                    }}
                  >
                    <button
                      type="button"
                      className="cc-mention-button"
                      aria-label="点名成员"
                      aria-expanded={mentionOpen}
                      onClick={() => setMentionOpen((open) => !open)}
                    >
                      <AtSign size={19} />
                    </button>
                    <textarea
                      ref={inputRef}
                      aria-label="以你自己的身份说点什么"
                      placeholder="以你自己的身份说点什么"
                      rows={1}
                      maxLength={12000}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          if (canSend) submitMessage();
                        }
                      }}
                    />
                    <button
                      className="cc-send-button"
                      type="submit"
                      aria-label={active || sendMode === "message" ? "发送消息" : "发送并讨论"}
                      disabled={!canSend}
                    >
                      {busy ? <Loader2 size={17} className="cc-spin" /> : <ArrowUp size={19} />}
                    </button>
                  </form>
                  {mentionOpen ? (
                    <div className="cc-mention-menu">
                      <b>让谁关注这条消息？</b>
                      {roomMembers.map((member) => (
                        <button
                          key={member.id}
                          type="button"
                          aria-pressed={mentions.includes(member.id)}
                          onClick={() => toggleMention(member.id)}
                        >
                          <CollaborationAvatar agent={member.agent} />
                          <span>{member.name}</span>
                          {mentions.includes(member.id) ? <Check size={15} /> : null}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="cc-mention-done"
                        onClick={() => {
                          setMentionOpen(false);
                          inputRef.current?.focus();
                        }}
                      >
                        完成
                      </button>
                    </div>
                  ) : null}
                  <div className="cc-composer-footer">
                    <span>
                      {active
                        ? "消息会保存在本群，当前讨论继续进行。"
                        : "Enter 发送 · Shift+Enter 换行"}
                    </span>
                    <div>
                      {active ? (
                        <button
                          className="cc-stop-button"
                          disabled={busy}
                          onClick={() => perform("stop")}
                        >
                          <Square size={11} fill="currentColor" />
                          停止讨论
                        </button>
                      ) : (
                        <select
                          aria-label="发送方式"
                          value={sendMode}
                          onChange={(event) =>
                            setSendMode(event.target.value as "discuss" | "message")
                          }
                        >
                          <option value="discuss">发送并讨论</option>
                          <option value="message">仅发送消息</option>
                        </select>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : null
          ) : (
            <div className="cc-empty-state">
              <h1>{allMembers.length ? "建个群，分好工。" : "接入你的第一个 Agent"}</h1>
              <div className="cc-pair-card">
                <h2>
                  {allMembers.length ? "让它们一起把事情做好。" : "把你常用的模型，变成协作成员。"}
                </h2>
                <p>
                  {allMembers.length
                    ? "把成员拉进一个群。一个负责调研，一个负责核对；它们讨论，你来拍板。"
                    : "选择已配置的模型和 Agent 能力，给它起个名字，然后邀请它加入你的群。"}
                </p>
                <button
                  className="cc-primary"
                  disabled={!sources.data}
                  onClick={() =>
                    setModal(
                      allMembers.filter((member) => member.available).length >= 2
                        ? "create"
                        : "add",
                    )
                  }
                >
                  <Plus size={18} />
                  {allMembers.filter((member) => member.available).length >= 2
                    ? "建个群"
                    : "添加成员"}
                </button>
              </div>
              <Link to="/" search={{}} className="cc-text-button cc-back-workbench">
                进入现有工作台
                <ChevronRight size={13} />
              </Link>
            </div>
          )}
        </section>
      </main>
      {modal === "add" && sources.data ? (
        <AddCollaborationMember
          sources={sources.data}
          onClose={() => setModal(null)}
          onAdded={() => {
            setTab("members");
          }}
        />
      ) : null}
      {modal === "create" ? (
        <CreateCollaborationRoom
          members={allMembers}
          onClose={() => setModal(null)}
          onCreated={(created) => {
            setTab("chats");
            selectRoom(created.id);
          }}
        />
      ) : null}
      {modal === "members" && room ? (
        <CollaborationMembers
          members={roomMembers}
          roles={
            new Map(
              room.participants.map((participant) => [participant.memberId, participant.role]),
            )
          }
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

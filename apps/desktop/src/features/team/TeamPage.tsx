import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Plus, Users, ClipboardList, ArrowUp, CornerUpLeft, X, ChevronRight } from "lucide-react";
import type {
  TeamSession,
  TeamDetail,
  TeamTask,
  TeamRoomInput,
  TeamTaskInput,
} from "@agentdesk/shared";
import { Markdown } from "../../components/Markdown";
import { http } from "../../lib/http";
import { isTeamHost, readTeamSessions, storeTeamSessions, teamRequest } from "./team-api";
import "../collaboration/collaboration.css";
import "./team.css";

const statuses: Record<TeamTask["status"], string> = {
  queued: "待领取",
  running: "执行中",
  blocked: "已阻塞",
  submitted: "待验收",
  approved: "已验收",
  cancelled: "已取消",
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : "操作未完成");
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className="collaboration-dialog team-dialog"
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <button type="button" aria-label="关闭" className="cc-modal-close" onClick={close}>
        <X size={18} />
      </button>
      <h2 id={id}>{title}</h2>
      {children}
    </dialog>
  );
}
function ProjectForm({
  save,
  busy,
  error,
}: {
  save: (input: TeamRoomInput, adminKey: string) => void;
  busy: boolean;
  error: unknown;
}) {
  return (
    <form
      className="cc-modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save(
          {
            name: String(data.get("name")),
            ownerName: String(data.get("owner")),
            goal: String(data.get("goal")),
            repository: String(data.get("repository")),
            baseRevision: String(data.get("base")),
          },
          String(data.get("admin") ?? ""),
        );
      }}
    >
      <label className="cc-field">
        项目名称
        <input name="name" required maxLength={100} />
      </label>
      <label className="cc-field">
        你的名字
        <input name="owner" required maxLength={80} />
      </label>
      <label className="cc-field">
        项目目标
        <textarea name="goal" required maxLength={12000} rows={3} />
      </label>
      <label className="cc-field">
        共享仓库地址
        <input
          name="repository"
          type="url"
          required
          placeholder="https://github.com/team/project.git"
        />
      </label>
      <label className="cc-field">
        起始提交 SHA
        <input name="base" required pattern="[a-f0-9]{40}" placeholder="完整的 40 位提交 SHA" />
      </label>
      {isTeamHost() ? (
        <label className="cc-field">
          团队服务管理密钥
          <input name="admin" type="password" required autoComplete="off" />
          <small>用于创建项目，不是模型 API Key。</small>
        </label>
      ) : null}
      <p className="cc-modal-note">
        每位成员使用自己的 Agent 和模型账号。代码通过独立分支交付，最终由你验收。
      </p>
      {error ? <p role="alert">{errorText(error)}</p> : null}
      <button className="cc-primary" disabled={busy}>
        创建项目群
      </button>
    </form>
  );
}
function TaskForm({
  detail,
  save,
  busy,
  error,
}: {
  detail: TeamDetail;
  save: (input: TeamTaskInput) => void;
  busy: boolean;
  error: unknown;
}) {
  return (
    <form
      className="cc-modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save({
          title: String(data.get("title")),
          instructions: String(data.get("instructions")),
          assigneeId: String(data.get("assignee")),
          kind: String(data.get("kind")) as TeamTaskInput["kind"],
          dependsOn: data.getAll("depends").map(String),
          acceptance: String(data.get("acceptance"))
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
        });
      }}
    >
      <label className="cc-field">
        任务名称
        <input name="title" required maxLength={200} />
      </label>
      <label className="cc-field">
        任务类型
        <select name="kind">
          <option value="develop">功能开发</option>
          <option value="integrate">汇总集成与回归</option>
        </select>
      </label>
      <label className="cc-field">
        分配给
        <select name="assignee">
          {detail.members
            .filter((member) => !member.revoked)
            .map((member) => (
              <option value={member.id} key={member.id}>
                {member.name}
                {member.executor ? ` · ${member.executor}` : " · 尚未连接 Agent"}
              </option>
            ))}
        </select>
      </label>
      <label className="cc-field">
        开发要求与范围
        <textarea name="instructions" required maxLength={16000} rows={4} />
      </label>
      <label className="cc-field">
        验收标准（每行一项）
        <textarea name="acceptance" required rows={3} maxLength={12000} />
      </label>
      <fieldset className="team-dependencies">
        <legend>依赖任务（验收后才能领取）</legend>
        {detail.tasks
          .filter((task) => task.status !== "cancelled")
          .map((task) => (
            <label key={task.id}>
              <input type="checkbox" name="depends" value={task.id} />
              {task.title} · {statuses[task.status]}
            </label>
          ))}
      </fieldset>
      <p className="cc-modal-note">
        集成任务需选择依赖交付。测试命令由执行成员在本机配置，群消息不能指定本机命令。
      </p>
      {error ? <p role="alert">{errorText(error)}</p> : null}
      <button className="cc-primary" disabled={busy}>
        分配任务
      </button>
    </form>
  );
}
function TaskCard({
  task,
  detail,
  review,
  busy,
}: {
  task: TeamTask;
  detail: TeamDetail;
  review: (action: string, note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const owner = detail.me.role === "owner";
  return (
    <article className={`team-task team-task-${task.status}`} data-testid="team-task">
      <div className="team-task-heading">
        <h3>{task.title}</h3>
        <span role="status">{statuses[task.status]}</span>
      </div>
      <p className="team-muted">
        {task.kind === "integrate" ? "集成回归" : "功能开发"} ·{" "}
        {detail.members.find((member) => member.id === task.assigneeId)?.name} · 第 {task.attempt}{" "}
        次执行
      </p>
      <p>{task.progress}</p>
      <details>
        <summary>要求与验收标准</summary>
        <p className="team-pre">{task.instructions}</p>
        <ul>
          {task.acceptance.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        {task.dependsOn.length ? (
          <p>
            依赖：
            {task.dependsOn
              .map((id) => detail.tasks.find((item) => item.id === id)?.title ?? id)
              .join("、")}
          </p>
        ) : null}
      </details>
      {task.delivery ? (
        <div className="team-delivery">
          <p>{task.delivery.summary}</p>
          <code>{task.delivery.revision}</code>
          <p className="team-muted">分支：{task.branch}</p>
          <ul>
            {task.delivery.checks.map((check, i) => (
              <li key={i}>
                {check.exitCode === 0 ? "✓" : "×"} {check.name} · exit {check.exitCode}
              </li>
            ))}
          </ul>
          <small>检查由该成员的连接端执行并上报，负责人仍需复核。</small>
        </div>
      ) : null}
      {owner && !["approved", "cancelled"].includes(task.status) ? (
        <div className="team-review">
          <label className="cc-field">
            验收或处理意见
            <input
              aria-label={`处理意见：${task.title}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="填写通过依据、修改要求或取消原因"
              maxLength={4000}
            />
          </label>
          <div>
            {task.status === "submitted" ? (
              <>
                <button
                  disabled={
                    busy ||
                    !note.trim() ||
                    task.delivery?.checks.some((check) => check.exitCode !== 0)
                  }
                  onClick={() => review("approve", note)}
                >
                  验收通过
                </button>
                <button disabled={busy || !note.trim()} onClick={() => review("revise", note)}>
                  退回修改
                </button>
              </>
            ) : null}
            {task.status === "blocked" ? (
              <button disabled={busy || !note.trim()} onClick={() => review("retry", note)}>
                明确重试
              </button>
            ) : null}
            <button disabled={busy || !note.trim()} onClick={() => review("cancel", note)}>
              取消任务
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
export function TeamPage() {
  const search = useSearch({ strict: false }) as { invite?: string };
  const navigate = useNavigate(),
    client = useQueryClient();
  const [sessions, setSessions] = useState(readTeamSessions);
  const [selected, setSelected] = useState(() => readTeamSessions()[0]?.room.id ?? "");
  const session = sessions.find((item) => item.room.id === selected);
  const [modal, setModal] = useState<"create" | "join" | "task" | "share" | null>(
    search.invite ? "join" : null,
  );
  const [code, setCode] = useState(search.invite ?? ""),
    [name, setName] = useState("");
  const [shared, setShared] = useState({ title: "", text: "", expiresAt: "" });
  const [tab, setTab] = useState<"chat" | "tasks" | "members">("chat");
  const [draft, setDraft] = useState(""),
    [reply, setReply] = useState<string | undefined>();
  const [mentions, setMentions] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const request = <T,>(path: string, body?: unknown) => teamRequest<T>(path, session?.token, body);
  const detail = useQuery({
    queryKey: ["team", selected, session?.member.id],
    queryFn: () => request<TeamDetail>("/room"),
    enabled: !!session,
    refetchInterval: 2500,
    retry: false,
  });
  const saveSession = (value: TeamSession) => {
    const next = [value, ...sessions.filter((item) => item.room.id !== value.room.id)];
    storeTeamSessions(next);
    setSessions(next);
    setSelected(value.room.id);
    setModal(null);
    void navigate({ to: "/team", search: {}, replace: true });
    setCode("");
  };
  const create = useMutation({
    mutationFn: ({ input, adminKey }: { input: TeamRoomInput; adminKey: string }) =>
      isTeamHost()
        ? teamRequest<TeamSession>("/create", adminKey, input)
        : http.post<TeamSession>("/team/rooms", input),
    onSuccess: saveSession,
  });
  const join = useMutation({
    mutationFn: () => teamRequest<TeamSession>("/join", undefined, { code, name }),
    onSuccess: saveSession,
  });
  const task = useMutation({
    mutationFn: (input: TeamTaskInput) => request("/tasks", input),
    onSuccess: () => {
      setModal(null);
      setTab("tasks");
      void detail.refetch();
    },
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => request(path, body),
    onSuccess: () => {
      void detail.refetch();
    },
  });
  const share = useMutation({
    mutationFn: async (kind: "invite" | "pair") => {
      const value = await request<{ code: string; expiresAt: string }>(
        kind === "invite" ? "/invites" : "/pairing-code",
        {},
      );
      return {
        title: kind === "invite" ? "邀请团队成员" : "连接我的 Agent",
        expiresAt: value.expiresAt,
        text:
          kind === "invite"
            ? `${window.location.origin}${window.location.pathname}#/team?invite=${encodeURIComponent(value.code)}`
            : value.code,
      };
    },
    onSuccess: (value) => {
      setShared(value);
      setModal("share");
    },
  });
  const send = useMutation({
    mutationFn: ({ content, requestId }: { content: string; requestId: string }) =>
      request("/messages", { content, requestId, replyToId: reply, mentionIds: mentions }),
    onSuccess: () => {
      setDraft("");
      setReply(undefined);
      setMentions([]);
      void detail.refetch().then(() => bottom.current?.scrollIntoView({ block: "end" }));
    },
  });
  const data = detail.data;
  const owner = data?.me.role === "owner";
  const error = detail.error ?? action.error ?? send.error ?? share.error;
  const exit = () => {
    const next = sessions.filter((item) => item.room.id !== selected);
    storeTeamSessions(next);
    setSessions(next);
    setSelected(next[0]?.room.id ?? "");
    client.removeQueries({ queryKey: ["team", selected] });
  };
  return (
    <div className="collaboration-page team-page">
      <header className="cc-nav">
        <Link to={isTeamHost() ? "/team" : "/welcome"} className="cc-logo">
          <img className="cc-logo-mark" src="/reference/icon.svg" alt="" />
          <span>AgentDesk</span>
        </Link>
        <div className="cc-nav-right">
          <span className="team-nav-label">团队开发</span>
          {!isTeamHost() ? (
            <Link to="/collaboration" className="cc-workbench-link">
              本地群聊
              <ChevronRight size={13} />
            </Link>
          ) : null}
          <button
            className="cc-owner-avatar"
            title={data?.me.name ?? "团队成员"}
            onClick={() => setTab("members")}
          >
            {data?.me.name.slice(0, 1) ?? "你"}
          </button>
        </div>
      </header>
      <div className="cc-workspace team-workspace">
        <aside className="cc-rail" aria-label="团队导航">
          <button className="cc-rail-item" onClick={() => setTab("chat")}>
            <Users />
            <span>讨论</span>
          </button>
          <button className="cc-rail-item" onClick={() => setTab("tasks")}>
            <ClipboardList />
            <span>任务</span>
          </button>
          <button className="cc-rail-item" onClick={() => setModal("create")}>
            <Plus />
            <span>新项目</span>
          </button>
        </aside>
        <aside className="cc-sidebar team-sidebar">
          <div className="cc-sidebar-heading">
            <h1>项目群</h1>
          </div>
          <div className="team-sidebar-actions">
            <button className="cc-outline-button" onClick={() => setModal("create")}>
              <Plus size={16} />
              创建项目
            </button>
            <button className="cc-text-button" onClick={() => setModal("join")}>
              使用邀请加入
            </button>
          </div>
          <div className="cc-sidebar-scroll">
            {sessions.map((item) => (
              <button
                key={item.room.id}
                className={`cc-room-item ${selected === item.room.id ? "is-selected" : ""}`}
                onClick={() => {
                  setSelected(item.room.id);
                  setTab("chat");
                }}
              >
                <span className="cc-room-icon">
                  <Users size={20} />
                </span>
                <span>
                  <b>{item.room.name}</b>
                  <small>{item.member.name} · 团队项目</small>
                </span>
              </button>
            ))}
            {!sessions.length ? (
              <p className="team-muted team-pad">把团队和不同的 Agent，放进同一个项目。</p>
            ) : null}
          </div>
        </aside>
        <main className="cc-main team-main">
          {session ? (
            <>
              <header className="team-room-header">
                <div>
                  <h1>{data?.room.name ?? session.room.name}</h1>
                  <p className="team-muted">{data?.room.goal}</p>
                </div>
                <div>
                  {owner ? (
                    <button
                      className="cc-outline-button"
                      disabled={share.isPending}
                      onClick={() => share.mutate("invite")}
                    >
                      邀请成员
                    </button>
                  ) : null}
                  <button
                    className="cc-primary"
                    disabled={share.isPending}
                    onClick={() => share.mutate("pair")}
                  >
                    连接我的 Agent
                  </button>
                </div>
              </header>
              <nav className="team-tabs" aria-label="项目视图">
                {(["chat", "tasks", "members"] as const).map((item) => (
                  <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
                    {{ chat: "群聊讨论", tasks: "任务与进度", members: "成员与连接" }[item]}
                  </button>
                ))}
              </nav>
              {error ? (
                <div role="alert" className="cc-action-error">
                  <span>{errorText(error)}</span>
                  <button onClick={() => void detail.refetch()}>刷新</button>
                  <button onClick={exit}>移除此浏览器记录</button>
                </div>
              ) : null}
              {data && tab === "chat" ? (
                <>
                  <div className="team-messages" aria-label="项目消息">
                    {!data.messages.length ? (
                      <p className="team-muted">
                        先讨论需求和接口，再分配开发任务。成员可以在网页或通过自己的 Agent 发言。
                      </p>
                    ) : null}
                    {data.messages.map((message) => (
                      <article
                        className={`cc-message ${message.authorKind === "system" ? "team-system" : ""}`}
                        key={message.id}
                        id={`team-message-${message.id}`}
                      >
                        <span className="cc-owner-avatar">
                          {message.authorKind === "system"
                            ? "·"
                            : data.members
                                .find((member) => member.id === message.authorId)
                                ?.name.slice(0, 1)}
                        </span>
                        <div className="cc-message-content">
                          <div className="cc-who">
                            <b>
                              {message.authorKind === "system"
                                ? "项目动态"
                                : data.members.find((member) => member.id === message.authorId)
                                    ?.name}
                              {message.authorKind === "agent" ? "的 Agent" : ""}
                            </b>
                            <span>
                              {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <div className="cc-bubble">
                            {message.replyToId ? (
                              <a
                                className="cc-quote"
                                href={`#team-message-${message.replyToId}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  document
                                    .getElementById(`team-message-${message.replyToId}`)
                                    ?.scrollIntoView({ block: "center" });
                                }}
                              >
                                引用：
                                {data.messages
                                  .find((item) => item.id === message.replyToId)
                                  ?.content.slice(0, 120)}
                              </a>
                            ) : null}
                            <Markdown>{message.content}</Markdown>
                            {message.mentionIds.map((id) => (
                              <small key={id}>
                                {" "}
                                @{data.members.find((member) => member.id === id)?.name}
                              </small>
                            ))}
                          </div>
                          {message.authorKind !== "system" ? (
                            <button
                              className="cc-reply-button"
                              onClick={() => setReply(message.id)}
                            >
                              <CornerUpLeft size={12} />
                              引用
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))}
                    <div ref={bottom} />
                  </div>
                  <form
                    className="team-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (draft.trim() && !send.isPending)
                        send.mutate({ content: draft.trim(), requestId: crypto.randomUUID() });
                    }}
                  >
                    {reply ? (
                      <div className="cc-composer-reply">
                        引用：
                        {data.messages
                          .find((message) => message.id === reply)
                          ?.content.slice(0, 80)}
                        <button
                          aria-label="取消引用"
                          type="button"
                          onClick={() => setReply(undefined)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : null}
                    <label className="team-sr" htmlFor="team-draft">
                      发送到项目群
                    </label>
                    <textarea
                      id="team-draft"
                      placeholder="讨论需求、核对接口，或给团队补充信息…"
                      value={draft}
                      maxLength={12000}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                    />
                    <div className="team-compose-bottom">
                      <select
                        aria-label="点名成员"
                        value=""
                        onChange={(event) => {
                          if (event.target.value && !mentions.includes(event.target.value))
                            setMentions([...mentions, event.target.value]);
                        }}
                      >
                        <option value="">@ 点名成员</option>
                        {data.members
                          .filter((member) => !member.revoked)
                          .map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                      </select>
                      <span>
                        {mentions.map((id) => (
                          <button
                            type="button"
                            key={id}
                            onClick={() => setMentions(mentions.filter((value) => value !== id))}
                          >
                            @{data.members.find((member) => member.id === id)?.name} ×
                          </button>
                        ))}
                      </span>
                      <button aria-label="发送群消息" disabled={send.isPending || !draft.trim()}>
                        <ArrowUp size={19} />
                      </button>
                    </div>
                  </form>
                </>
              ) : null}
              {data && tab === "tasks" ? (
                <section className="team-tasks">
                  <div className="team-task-top">
                    <p>待领取 → 执行 → 交付 → 验收；各功能通过后，再分配集成回归任务。</p>
                    {owner ? (
                      <button className="cc-primary" onClick={() => setModal("task")}>
                        <Plus size={16} />
                        分配任务
                      </button>
                    ) : null}
                  </div>
                  {!data.tasks.length ? (
                    <p className="team-muted">还没有任务。先明确开发范围、负责人和验收标准。</p>
                  ) : null}
                  {data.tasks.map((item) => (
                    <TaskCard
                      key={item.id}
                      task={item}
                      detail={data}
                      busy={action.isPending}
                      review={(reviewAction, note) =>
                        action.mutate({
                          path: `/tasks/${item.id}/review`,
                          body: { action: reviewAction, note },
                        })
                      }
                    />
                  ))}
                </section>
              ) : null}
              {data && tab === "members" ? (
                <section className="team-members">
                  <p className="team-muted">
                    Agent
                    通过成员本机主动连接。离线时不会代为运行；撤权后连接程序在下次心跳时停止，最长一个租约周期。
                  </p>
                  {data.members.map((member) => (
                    <article key={member.id}>
                      <div>
                        <b>
                          {member.name}
                          {member.role === "owner" ? " · 负责人" : ""}
                        </b>
                        <p>
                          {member.revoked ? "权限已撤销" : (member.executor ?? "尚未配对 Agent")}{" "}
                          {member.connectedAt
                            ? `· 最近连接 ${new Date(member.connectedAt).toLocaleString("zh-CN")}`
                            : ""}
                        </p>
                      </div>
                      {!member.revoked && (owner || member.id === data.me.id) ? (
                        <div>
                          {member.id === data.me.id || owner ? (
                            <button
                              disabled={action.isPending}
                              onClick={() => {
                                if (confirm(`撤销 ${member.name} 的 Agent 连接并停止未完成任务？`))
                                  action.mutate({
                                    path: `/members/${member.id}/revoke`,
                                    body: { connectionOnly: true },
                                  });
                              }}
                            >
                              撤销 Agent
                            </button>
                          ) : null}
                          {owner && member.role !== "owner" ? (
                            <button
                              disabled={action.isPending}
                              onClick={() => {
                                if (confirm(`移除 ${member.name} 的项目访问权限？`))
                                  action.mutate({
                                    path: `/members/${member.id}/revoke`,
                                    body: { connectionOnly: false },
                                  });
                              }}
                            >
                              移除成员
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                  {owner ? (
                    <button
                      className="cc-text-button"
                      disabled={action.isPending}
                      onClick={() => {
                        if (confirm("让所有尚未使用的邀请链接立即失效？"))
                          action.mutate({ path: "/invites/revoke", body: {} });
                      }}
                    >
                      撤销未使用的邀请
                    </button>
                  ) : null}
                  <button className="cc-text-button" onClick={exit}>
                    退出此浏览器的项目会话
                  </button>
                  <p className="team-muted">
                    仓库：{data.room.repository}
                    <br />
                    起始提交：{data.room.baseRevision}
                  </p>
                </section>
              ) : null}
            </>
          ) : (
            <div className="cc-empty-state">
              <h1>一起把项目做完。</h1>
              <div className="cc-pair-card">
                <h2>你的团队，各自的 Agent。</h2>
                <p>
                  邀请成员，用 Claude Code、Codex 或其他 Agent
                  分工开发；进度和交付回到同一个项目群。
                </p>
                <button className="cc-primary" onClick={() => setModal("create")}>
                  创建项目群
                </button>
                <button className="cc-text-button" onClick={() => setModal("join")}>
                  我有邀请链接
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
      {modal === "create" ? (
        <Modal title="创建团队项目" close={() => setModal(null)}>
          <ProjectForm
            busy={create.isPending}
            error={create.error}
            save={(input, adminKey) => create.mutate({ input, adminKey })}
          />
        </Modal>
      ) : null}
      {modal === "join" ? (
        <Modal title="加入团队项目" close={() => setModal(null)}>
          <form
            className="cc-modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              join.mutate();
            }}
          >
            <label className="cc-field">
              你的名字
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
              />
            </label>
            <label className="cc-field">
              单次邀请码
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <p className="cc-modal-note">
              加入后可读取项目群历史与交付；连接 Agent 还需你在本机明确配对。
            </p>
            {join.error ? <p role="alert">{errorText(join.error)}</p> : null}
            <button className="cc-primary" disabled={join.isPending}>
              确认加入
            </button>
          </form>
        </Modal>
      ) : null}
      {modal === "task" && data ? (
        <Modal title="分配开发任务" close={() => setModal(null)}>
          <TaskForm
            detail={data}
            save={(input) => task.mutate(input)}
            busy={task.isPending}
            error={task.error}
          />
        </Modal>
      ) : null}
      {modal === "share" ? (
        <Modal
          title={shared.title}
          close={() => {
            setShared({ title: "", text: "", expiresAt: "" });
            setModal(null);
          }}
        >
          <p className="cc-modal-note">
            单次有效，截止 {new Date(shared.expiresAt).toLocaleString("zh-CN")}。请只发给对应成员。
          </p>
          <textarea
            aria-label={shared.title === "连接我的 Agent" ? "Agent 配对码" : "项目邀请链接"}
            className="team-share"
            readOnly
            value={shared.text}
            onFocus={(event) => event.target.select()}
          />
          {shared.title === "连接我的 Agent" ? (
            <>
              <p>在自己的终端执行：</p>
              <code className="team-command">
                {isTeamHost() ? "agentdesk-team pair --server " : "agentdesk team pair --server "}
                {isTeamHost() ? window.location.origin : "https://团队服务地址"}
              </code>
              <p className="cc-modal-note">
                按提示输入上方配对码。模型登录和 API Key 留在本机；随后运行连接端的 work
                命令领取任务。
              </p>
              {isTeamHost() ? (
                <p>
                  <a href="/downloads/TEAM-GUIDE.txt" target="_blank" rel="noreferrer">
                    查看连接端安装与团队接入说明
                  </a>
                </p>
              ) : null}
            </>
          ) : (
            <p className="cc-modal-note">
              当前页面必须部署为团队可访问的 HTTPS 地址后，邀请链接才能供异地成员使用。
            </p>
          )}
        </Modal>
      ) : null}
    </div>
  );
}

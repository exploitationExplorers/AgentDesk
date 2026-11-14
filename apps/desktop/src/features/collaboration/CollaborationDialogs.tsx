import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Loader2, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  AgentName,
  CollaborationMember,
  CollaborationRole,
  CollaborationRoom,
  CollaborationSources,
} from "@agentdesk/shared";
import { collaborationApi } from "./collaboration-api";
import { CollaborationAvatar } from "./CollaborationAvatar";

export const collaborationRoleLabels: Record<CollaborationRole, string> = {
  research: "调研资料",
  verify: "核对来源",
  summarize: "形成总结",
};

export function collaborationError(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

function CollaborationDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="collaboration-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <button type="button" className="cc-modal-close" onClick={onClose} aria-label="关闭">
        <X size={17} />
      </button>
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>,
    document.body,
  );
}

export function AddCollaborationMember({
  sources,
  onClose,
  onAdded,
}: {
  sources: CollaborationSources;
  onClose: () => void;
  onAdded: (member: CollaborationMember) => void;
}) {
  const client = useQueryClient();
  const available = sources.providers.filter((provider) => provider.available);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<AgentName>(sources.agents[0]?.id ?? "research");
  const [providerId, setProviderId] = useState(available[0]?.id ?? "");
  const provider = available.find((item) => item.id === providerId);
  const [model, setModel] = useState(provider?.defaultModel ?? provider?.models[0] ?? "");
  const add = useMutation({
    mutationFn: () =>
      collaborationApi.addMember({
        name: name.trim(),
        agent,
        modelSelection: { providerId, model: model.trim() },
      }),
    onSuccess: (member) => {
      void client.invalidateQueries({ queryKey: ["collaboration", "members"] });
      onAdded(member);
      onClose();
    },
  });
  return (
    <CollaborationDialog title="添加成员" onClose={onClose}>
      <div className="cc-sender">
        添加到{" "}
        <span className="cc-sender-pill">
          <CollaborationAvatar />
          你的 Agent
        </span>
      </div>
      {!available.length ? (
        <div className="cc-modal-empty">
          <h3>先连接一个模型。</h3>
          <p>成员使用你在 AgentDesk 中配置的模型。配置完成后，就能让它们一起调研和核对。</p>
          {sources.providers.map((item) => (
            <p key={item.id}>
              {item.name}：{item.unavailableReason ?? "当前不可用"}
            </p>
          ))}
          <Link className="cc-primary" to="/settings" search={{ tab: "providers" }}>
            配置模型
          </Link>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!add.isPending) add.mutate();
          }}
        >
          <p className="cc-modal-description">给它起个名字，选择它擅长的工作。</p>
          <label className="cc-field">
            成员名称
            <input
              autoFocus
              maxLength={80}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的调研助手"
            />
          </label>
          <label className="cc-field">
            Agent 能力
            <select value={agent} onChange={(event) => setAgent(event.target.value as AgentName)}>
              {sources.agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="cc-field">
            模型服务
            <select
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                const next = available.find((item) => item.id === event.target.value);
                setModel(next?.defaultModel ?? next?.models[0] ?? "");
              }}
            >
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="cc-field">
            模型
            <select
              aria-label="模型"
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {provider?.models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <p className="cc-modal-note">使用已配置的模型服务；无需登录外部聊天账号。</p>
          {add.error ? (
            <p className="cc-error" role="alert">
              {collaborationError(add.error)}
            </p>
          ) : null}
          <button
            className="cc-primary"
            type="submit"
            disabled={add.isPending || !name.trim() || !model.trim() || !providerId}
          >
            {add.isPending ? <Loader2 className="cc-spin" size={17} /> : <Plus size={17} />}添加成员
          </button>
        </form>
      )}
    </CollaborationDialog>
  );
}

export function CreateCollaborationRoom({
  members,
  onClose,
  onCreated,
}: {
  members: CollaborationMember[];
  onClose: () => void;
  onCreated: (room: CollaborationRoom) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [maxRounds, setMaxRounds] = useState(2);
  const [selected, setSelected] = useState<Record<string, CollaborationRole>>(() =>
    Object.fromEntries(
      members
        .filter((item) => item.available)
        .slice(0, 3)
        .map((item, index) => [
          item.id,
          index === 0 ? "research" : index === 1 ? "verify" : "summarize",
        ]),
    ),
  );
  const count = Object.keys(selected).length;
  const roles = Object.values(selected);
  const validRoles = roles.includes("research") && roles.includes("verify");
  const create = useMutation({
    mutationFn: () =>
      collaborationApi.createRoom({
        name: name.trim(),
        topic: topic.trim(),
        maxRounds,
        participants: Object.entries(selected).map(([memberId, role]) => ({ memberId, role })),
      }),
    onSuccess: (room) => {
      void client.invalidateQueries({ queryKey: ["collaboration", "rooms"] });
      onCreated(room);
      onClose();
    },
  });
  return (
    <CollaborationDialog title="建个群，分好工" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <label className="cc-field">
          群名称
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品研究小组"
          />
        </label>
        <label className="cc-field">
          这次一起做什么？
          <textarea
            required
            maxLength={12000}
            rows={3}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="给出目标、需要核对的问题，以及你想得到的结果。"
          />
        </label>
        <p className="cc-section-label">
          选择成员与分工 <span>{count}/6</span>
        </p>
        <div className="cc-room-members">
          {members.map((member) => {
            const active = Object.hasOwn(selected, member.id);
            return (
              <div className={`cc-role-row ${active ? "is-selected" : ""}`} key={member.id}>
                <button
                  type="button"
                  className="cc-member-toggle"
                  aria-pressed={active}
                  disabled={!member.available || (!active && count >= 6)}
                  onClick={() =>
                    setSelected((previous) => {
                      const next = { ...previous };
                      if (active) delete next[member.id];
                      else
                        next[member.id] =
                          count === 0 ? "research" : count === 1 ? "verify" : "summarize";
                      return next;
                    })
                  }
                >
                  <span className="cc-check">{active ? <Check size={12} /> : null}</span>
                  <CollaborationAvatar agent={member.agent} />
                  <span>
                    <b>{member.name}</b>
                    <small>
                      {member.available
                        ? member.modelSelection.model
                        : (member.unavailableReason ?? "模型不可用")}
                    </small>
                  </span>
                </button>
                {active ? (
                  <select
                    aria-label={`${member.name}的分工`}
                    value={selected[member.id]}
                    onChange={(event) =>
                      setSelected((previous) => ({
                        ...previous,
                        [member.id]: event.target.value as CollaborationRole,
                      }))
                    }
                  >
                    {Object.entries(collaborationRoleLabels).map(([role, label]) => (
                      <option key={role} value={role}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            );
          })}
        </div>
        <label className="cc-field cc-round-field">
          最多讨论几轮
          <select value={maxRounds} onChange={(event) => setMaxRounds(Number(event.target.value))}>
            {[1, 2, 3].map((round) => (
              <option key={round} value={round}>
                {round} 轮
              </option>
            ))}
          </select>
        </label>
        <p className="cc-modal-note">
          至少 2 名成员，安排一个调研、一个核对。讨论结束后，由你拍板。
        </p>
        {count >= 2 && !validRoles ? (
          <p className="cc-error" role="alert">
            请同时安排“调研资料”和“核对来源”。
          </p>
        ) : null}
        {create.error ? (
          <p className="cc-error" role="alert">
            {collaborationError(create.error)}
          </p>
        ) : null}
        <button
          className="cc-primary"
          disabled={create.isPending || count < 2 || !validRoles || !name.trim() || !topic.trim()}
        >
          {create.isPending ? <Loader2 className="cc-spin" size={17} /> : null}建群并准备讨论
        </button>
      </form>
    </CollaborationDialog>
  );
}

export function CollaborationMembers({
  members,
  roles,
  onClose,
}: {
  members: CollaborationMember[];
  roles: Map<string, CollaborationRole>;
  onClose: () => void;
}) {
  return (
    <CollaborationDialog title="成员与分工" onClose={onClose}>
      {members.map((member) => (
        <div className="cc-connected-member" key={member.id}>
          <CollaborationAvatar agent={member.agent} />
          <span>
            <strong>{member.name}</strong>
            <small>
              {roles.has(member.id)
                ? collaborationRoleLabels[roles.get(member.id)!]
                : member.modelSelection.model}
            </small>
            <small>
              {member.available
                ? member.modelSelection.model
                : (member.unavailableReason ?? "当前不可用")}
            </small>
          </span>
        </div>
      ))}
    </CollaborationDialog>
  );
}

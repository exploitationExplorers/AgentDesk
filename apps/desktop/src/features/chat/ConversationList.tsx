import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  FolderPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Conversation, ConversationGroup, ConversationPatch } from "@agentdesk/shared";
import {
  AnimatePresence,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  cn,
  listItemVariants,
  motion,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { toast } from "../../lib/toast";
import { conversationsApi } from "./conversations-api";

export function ConversationList({ activeId }: { activeId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [editing, setEditing] = useState<Conversation | null>(null);
  const [groupEditor, setGroupEditor] = useState<ConversationGroup | "new" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const groups = useQuery({ queryKey: ["conversation-groups"], queryFn: conversationsApi.groups });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const approvals = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
  });
  const waiting = new Set(approvals.data?.map((approval) => approval.conversationId));
  const conversations = useQuery({
    queryKey: ["conversations", { search: query, archived, groupId }],
    queryFn: () =>
      conversationsApi.list({
        search: query,
        archived: archived ? "archived" : "active",
        groupId: groupId || undefined,
      }),
  });

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      queryClient.invalidateQueries({ queryKey: ["conversation", activeId] }),
      queryClient.invalidateQueries({ queryKey: ["conversation-state", activeId] }),
      queryClient.invalidateQueries({ queryKey: ["session-workbench", activeId] }),
    ]);
  };
  const patch = useMutation({
    mutationFn: ({ id, value }: { id: string; value: ConversationPatch }) =>
      conversationsApi.patch(id, value),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: conversationsApi.remove,
    onSuccess: async (_, id) => {
      setEditing(null);
      if (id === activeId) void navigate({ to: "/", search: {} });
      await refresh();
    },
  });
  const clearAll = useMutation({
    mutationFn: async (ids: string[]) => {
      const failures: string[] = [];
      for (const id of ids) {
        try {
          await conversationsApi.remove(id);
        } catch {
          failures.push(id);
        }
      }
      return { cleared: ids.length - failures.length, failed: failures.length };
    },
    onSuccess: async (result, ids) => {
      setConfirmClear(false);
      if (activeId && ids.includes(activeId)) void navigate({ to: "/", search: {} });
      await refresh();
      toast(
        result.failed
          ? `已清空 ${result.cleared} 个会话，${result.failed} 个失败`
          : `已清空 ${result.cleared} 个会话`,
        { tone: result.failed ? "warning" : "success" },
      );
    },
    onError: (error: Error) => toast(error.message || "清空失败", { tone: "danger" }),
  });
  const clearableIds = useMemo(
    () => (conversations.data ?? []).map((item) => item.id),
    [conversations.data],
  );
  const sections = useMemo(() => {
    const list = conversations.data ?? [];
    const result = [{ id: "pinned", name: "置顶", items: list.filter((item) => item.pinned) }];
    const unpinned = list.filter((item) => !item.pinned);
    if (groupId || query)
      result.push({ id: "results", name: query ? "搜索结果" : "会话", items: unpinned });
    else {
      for (const group of groups.data ?? [])
        result.push({
          id: group.id,
          name: group.name,
          items: unpinned.filter((item) => item.groupId === group.id),
        });
      result.push({
        id: "ungrouped",
        name: "未分组",
        items: unpinned.filter(
          (item) =>
            !item.groupId || !(groups.data ?? []).some((group) => group.id === item.groupId),
        ),
      });
    }
    return result.filter((section) => section.items.length > 0);
  }, [conversations.data, groups.data, groupId, query]);
  const error = conversations.error ?? groups.error ?? patch.error ?? remove.error;

  return (
    <aside className="chat-history flex w-[248px] shrink-0 flex-col border-r" aria-label="会话列表">
      <div className="grid gap-3 p-4">
        <div className="flex h-7 items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-wide">对话</h2>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums text-muted">
            {conversations.data?.length ?? 0}
          </span>
        </div>
        <Button
          variant="secondary"
          className="h-10 justify-start rounded-xl border-brand/15 bg-surface text-brand shadow-sm hover:bg-brand/6"
          onClick={() => void navigate({ to: "/", search: {} })}
        >
          <MessageSquarePlus className="h-4 w-4" strokeWidth={1.75} />
          新对话
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-subtle" />
          <Input
            aria-label="搜索会话"
            placeholder="搜索标题或正文"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 rounded-xl border-transparent bg-surface/60 pl-9 text-xs focus:border-brand/30"
          />
        </div>
        <div className="flex items-center gap-1">
          <Select
            aria-label="筛选会话分组"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className="min-w-0 flex-1 text-xs"
          >
            <option value="">全部分组</option>
            <option value="ungrouped">未分组</option>
            {(groups.data ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          <button
            type="button"
            aria-label="新建会话分组"
            title="新建分组"
            className="rounded-lg p-2 text-muted hover:bg-surface-2"
            onClick={() => setGroupEditor("new")}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          {groupId && groupId !== "ungrouped" ? (
            <button
              type="button"
              aria-label="管理当前分组"
              title="管理分组"
              className="rounded-lg p-2 text-muted hover:bg-surface-2"
              onClick={() =>
                setGroupEditor(groups.data?.find((group) => group.id === groupId) ?? null)
              }
            >
              <Settings2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={archived}
            onClick={() => setArchived((value) => !value)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-xs",
              archived ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
            )}
          >
            <Archive className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {archived ? "正在查看已归档 · 返回会话" : "查看已归档"}
            </span>
          </button>
          {!archived ? (
            <button
              type="button"
              aria-label="一键清空会话"
              title="一键清空"
              disabled={!clearableIds.length || clearAll.isPending}
              onClick={() => setConfirmClear(true)}
              className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {error ? (
          <p role="alert" className="px-2 py-2 text-xs text-danger">
            {error.message}
          </p>
        ) : null}
        {conversations.isLoading ? (
          <p className="px-2 py-3 text-xs text-subtle">正在加载会话…</p>
        ) : null}
        {!conversations.isLoading && !conversations.error && sections.length === 0 ? (
          <p className="px-2 py-4 text-xs leading-5 text-subtle">
            {query ? "没有找到匹配的会话" : archived ? "还没有归档会话" : "这里会保存你的对话"}
          </p>
        ) : null}
        {sections.map((section) => (
          <section key={section.id} aria-label={section.name} className="mb-3">
            <h2 className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-subtle">
              {section.name === "未分组" && !groupId && !query ? "最近" : section.name}
            </h2>
            <AnimatePresence initial={false}>
              {section.items.map((conversation) => (
                <motion.div
                  key={conversation.id}
                  layout="position"
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className={cn(
                    "group relative isolate mb-1 flex items-center gap-1 overflow-hidden rounded-xl border border-transparent transition-colors",
                    conversation.id === activeId
                      ? "border-brand/10 bg-brand/7 text-fg"
                      : "text-muted hover:bg-surface-2/70",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/", search: { c: conversation.id } })}
                    className="min-w-0 flex-1 px-3 py-2.5 text-left"
                    aria-current={conversation.id === activeId ? "page" : undefined}
                  >
                    <span className="flex items-center gap-1.5 text-[13px] font-medium">
                      {conversation.pinned ? <Pin className="h-3 w-3 shrink-0 text-brand" /> : null}
                      <span className="truncate">{conversation.title}</span>
                      {waiting.has(conversation.id) ? (
                        <span className="ml-auto shrink-0 text-[10px] font-normal text-brand">
                          待回复
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate text-[11px] font-normal text-subtle">
                      {projects.data?.find((project) => project.id === conversation.projectId)
                        ?.name ?? timeAgo(conversation.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`管理会话：${conversation.title}`}
                    title="管理会话"
                    className="mr-1 rounded p-1 text-subtle opacity-70 hover:bg-surface hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => {
                      patch.reset();
                      remove.reset();
                      setEditing(conversation);
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </section>
        ))}
      </div>
      {editing ? (
        <ConversationEditor
          key={editing.id}
          conversation={editing}
          groups={groups.data ?? []}
          projects={projects.data ?? []}
          onClose={() => setEditing(null)}
          onSave={(value) => patch.mutate({ id: editing.id, value })}
          onDelete={() => remove.mutate(editing.id)}
          pending={patch.isPending || remove.isPending}
          error={patch.error ?? remove.error}
        />
      ) : null}
      {groupEditor ? (
        <GroupEditor
          key={typeof groupEditor === "string" ? groupEditor : groupEditor.id}
          group={groupEditor}
          onClose={() => setGroupEditor(null)}
          onSaved={async (removedId) => {
            if (removedId === groupId) setGroupId("");
            setGroupEditor(null);
            await queryClient.invalidateQueries({ queryKey: ["conversation-groups"] });
            await refresh();
          }}
        />
      ) : null}
      {confirmClear ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !clearAll.isPending) setConfirmClear(false);
          }}
          title="一键清空会话"
          description={`将永久删除当前列表中的 ${clearableIds.length} 个会话及其消息，此操作不可恢复。`}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={clearAll.isPending}
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={clearAll.isPending}
                disabled={!clearableIds.length || clearAll.isPending}
                onClick={() => clearAll.mutate(clearableIds)}
              >
                确认清空
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            {groupId || query
              ? "仅清空当前筛选结果中的会话；其他分组不受影响。"
              : "清空后可在「查看已归档」之外重新开始对话。已归档会话不会被删除。"}
          </p>
        </Dialog>
      ) : null}
    </aside>
  );
}

function ConversationEditor({
  conversation,
  groups,
  projects,
  onClose,
  onSave,
  onDelete,
  pending,
  error,
}: {
  conversation: Conversation;
  groups: ConversationGroup[];
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (patch: ConversationPatch) => void;
  onDelete: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [groupId, setGroupId] = useState(conversation.groupId ?? "");
  const [projectId, setProjectId] = useState(conversation.projectId ?? "");
  const [pinned, setPinned] = useState(conversation.pinned ?? false);
  const [archived, setArchived] = useState(conversation.archived ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = () => {
    const patch: ConversationPatch = {
      title: title.trim(),
      pinned,
      archived,
      groupId: groupId || null,
    };
    if (projectId !== (conversation.projectId ?? "")) patch.projectId = projectId || null;
    onSave(patch);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title="管理会话"
      description="整理会话并选择后续对话使用的项目。"
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button disabled={pending || !title.trim()} loading={pending} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="会话名称">
          <Input
            aria-label="会话名称"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="所属分组">
          <Select
            aria-label="所属分组"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
          >
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="关联项目">
          <Select
            aria-label="关联项目"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">不关联项目</option>
            {projectId && !projects.some((project) => project.id === projectId) ? (
              <option value={projectId}>原项目已移除</option>
            ) : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            置顶会话
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            归档会话
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error.message}
          </p>
        ) : null}
        <div className="border-t pt-3">
          {confirmDelete ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-danger">会话和消息将永久删除。</p>
              <Button variant="danger" size="sm" disabled={pending} onClick={onDelete}>
                确认删除
              </Button>
            </div>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-danger"
            >
              删除会话…
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function GroupEditor({
  group,
  onClose,
  onSaved,
}: {
  group: ConversationGroup | "new";
  onClose: () => void;
  onSaved: (removedId?: string) => Promise<void>;
}) {
  const [name, setName] = useState(group === "new" ? "" : group.name);
  const save = useMutation({
    mutationFn: () =>
      group === "new"
        ? conversationsApi.createGroup(name.trim())
        : conversationsApi.renameGroup(group.id, name.trim()),
    onSuccess: () => onSaved(),
  });
  const remove = useMutation({
    mutationFn: () =>
      group === "new" ? Promise.resolve() : conversationsApi.removeGroup(group.id),
    onSuccess: () => onSaved(group === "new" ? undefined : group.id),
  });
  const pending = save.isPending || remove.isPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={group === "new" ? "新建会话分组" : "管理会话分组"}
      description="按项目、客户或主题整理，会话各自保留上下文。"
      footer={
        <Button disabled={pending || !name.trim()} loading={pending} onClick={() => save.mutate()}>
          保存分组
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label="分组名称">
          <Input
            aria-label="分组名称"
            value={name}
            autoFocus
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim() && !pending) save.mutate();
            }}
          />
        </Field>
        {save.error || remove.error ? (
          <p role="alert" className="text-xs text-danger">
            {(save.error ?? remove.error)?.message}
          </p>
        ) : null}
        {group !== "new" ? (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-subtle">删除分组后，会话移至“未分组”。</p>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove.mutate()}>
              删除分组
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Memory, MemoryKind, MemoryPolicy } from "@agentdesk/shared";
import { Badge, Button, Card, EmptyState, Spinner, Textarea } from "@agentdesk/ui";
import { api } from "../../lib/api";

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: "偏好",
  fact: "事实",
  decision: "决定",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function isExpired(item: Memory): boolean {
  return !!item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now();
}

function statusLabel(item: Memory): string {
  if (item.status === "superseded") return "已被更正";
  if (isExpired(item)) return "已过期";
  return item.status === "candidate" ? "待确认" : "已生效";
}

function PolicySwitch({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-3 first:pt-0 last:pb-0">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-brand"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="mt-1 block text-xs leading-6 text-subtle">{description}</span>
      </span>
    </label>
  );
}

export function MemoryTab() {
  const client = useQueryClient();
  const memories = useQuery({ queryKey: ["memories"], queryFn: api.memories });
  const policy = useQuery({ queryKey: ["memory-policy"], queryFn: api.memoryPolicy });
  const [filter, setFilter] = useState<"current" | "candidate" | "all">("current");
  const update = useMutation({
    mutationFn: api.updateMemoryPolicy,
    onSuccess: (next) => client.setQueryData(["memory-policy"], next),
  });
  const change = (key: keyof MemoryPolicy, value: boolean) => {
    if (policy.data) update.mutate({ ...policy.data, [key]: value });
  };
  const items = memories.data ?? [];
  const candidates = items.filter((item) => item.status === "candidate" && !isExpired(item));
  const shown = items.filter((item) =>
    filter === "all"
      ? true
      : filter === "candidate"
        ? item.status === "candidate" && !isExpired(item)
        : item.status === "active" && !isExpired(item),
  );

  return (
    <div className="grid min-w-0 max-w-4xl gap-5">
      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">记忆与提取</h3>
        {policy.isPending ? <Spinner /> : null}
        {policy.isError ? (
          <p role="alert" className="text-xs text-danger">
            {policy.error.message}
          </p>
        ) : null}
        {policy.data ? (
          <div className="divide-y divide-border/60">
            <PolicySwitch
              title="启用长期记忆"
              description="在对话和任务中保存并召回相关记忆。关闭后，已保存记录仍可在这里管理。"
              checked={policy.data.enabled}
              disabled={update.isPending}
              onChange={(value) => change("enabled", value)}
            />
            <PolicySwitch
              title="自动提取候选记忆"
              description="从对话中整理稳定偏好、事实和决定。候选经你确认后才会被召回。"
              checked={policy.data.autoCaptureEnabled}
              disabled={update.isPending}
              onChange={(value) => change("autoCaptureEnabled", value)}
            />
            <PolicySwitch
              title="允许模型提取"
              description="提取会把相关用户文本发送给当前配置的模型；云模型会收到这些文本。关闭后仍可手动记住信息。"
              checked={policy.data.allowCloudExtraction}
              disabled={update.isPending}
              onChange={(value) => change("allowCloudExtraction", value)}
            />
          </div>
        ) : null}
        {update.isError ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            保存失败：{update.error.message}
          </p>
        ) : null}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="记忆筛选">
          {(
            [
              ["current", "已生效"],
              ["candidate", `待确认 ${candidates.length}`],
              ["all", "全部记录"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "primary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-subtle">{shown.length} 条记录</span>
      </div>
      <p className="text-xs leading-6 text-subtle">
        用户偏好与项目事实按作用域保留。API
        Key、密码等凭据不进入普通记忆。更正会保留替代关系；删除后会抑制旧内容被自动重新提取。
      </p>
      {memories.isPending ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Spinner />
          正在加载记忆…
        </div>
      ) : null}
      {memories.isError ? (
        <Card className="p-4">
          <p role="alert" className="text-xs text-danger">
            加载失败：{memories.error.message}
          </p>
          <Button className="mt-3" size="sm" onClick={() => void memories.refetch()}>
            重试
          </Button>
        </Card>
      ) : null}
      {memories.isSuccess && shown.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-6 w-6" />}
          title={filter === "candidate" ? "没有待确认的记忆" : "这里还没有记忆"}
          description={
            filter === "candidate"
              ? "自动提取的候选会出现在这里。"
              : "在对话中说“记住……”可以保存稳定信息。"
          }
        />
      ) : null}
      {shown.length > 0 ? (
        <Card>
          {shown.map((item) => (
            <MemoryRow key={item.id} item={item} />
          ))}
        </Card>
      ) : null}
    </div>
  );
}

function MemoryRow({ item }: { item: Memory }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [deleting, setDeleting] = useState(false);
  const mutation = useMutation({
    mutationFn: async (action: "approve" | "correct" | "delete") => {
      if (action === "approve") return await api.approveMemory(item.id);
      if (action === "correct") return await api.correctMemory(item.id, text.trim());
      return await api.deleteMemory(item.id);
    },
    onSuccess: () => {
      setEditing(false);
      setDeleting(false);
      void client.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const expired = isExpired(item);
  const candidate = item.status === "candidate" && !expired;
  return (
    <div className="flex items-start gap-3 border-b border-border/60 p-4 last:border-b-0">
      <Brain className="mt-1 h-4 w-4 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="brand">{KIND_LABEL[item.kind]}</Badge>
          <Badge
            tone={
              candidate ? "warning" : item.status === "active" && !expired ? "success" : "neutral"
            }
          >
            {statusLabel(item)}
          </Badge>
          <Badge>{item.scope === "project" ? "项目" : "用户"}</Badge>
          <Badge>{item.source === "auto" ? "自动提取" : "手动记录"}</Badge>
        </div>
        {editing ? (
          <div className="mt-3 grid gap-2">
            <Textarea
              aria-label="更正记忆内容"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={500}
              rows={3}
              disabled={mutation.isPending}
            />
            <p className="text-xs text-subtle">确认后的内容会生效，原记录标记为已被更正。</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={mutation.isPending}
                disabled={text.trim().length < 2 || text.trim() === item.text}
                onClick={() => mutation.mutate("correct")}
              >
                保存更正
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => {
                  setEditing(false);
                  setText(item.text);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-7">{item.text}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-5 text-subtle">
          <span>更新于 {formatTime(item.updatedAt)}</span>
          <span className="break-all">作用域：{item.namespace}</span>
          {item.expiresAt ? <span>有效至 {formatTime(item.expiresAt)}</span> : null}
        </div>
        {item.evidence ? (
          <p className="mt-1 break-words text-[11px] leading-5 text-subtle">
            来源：{item.evidence}
          </p>
        ) : null}
        {item.conversationId ? (
          <p className="mt-1 break-all text-[11px] text-subtle">来源会话：{item.conversationId}</p>
        ) : null}
        {!editing && !deleting ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {candidate ? (
              <Button
                size="sm"
                variant="primary"
                loading={mutation.isPending && mutation.variables === "approve"}
                disabled={mutation.isPending}
                onClick={() => mutation.mutate("approve")}
              >
                <Check className="h-3.5 w-3.5" />
                确认记住
              </Button>
            ) : null}
            {item.status !== "superseded" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.reset();
                  setEditing(true);
                }}
              >
                <Pencil className="h-3 w-3" />
                更正
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => {
                mutation.reset();
                setDeleting(true);
              }}
            >
              <Trash2 className="h-3 w-3" />
              删除
            </Button>
          </div>
        ) : null}
        {deleting ? (
          <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3">
            <p className="text-xs leading-6">
              删除这条记忆？它将不再被召回，旧内容也不会被自动重新记住。
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={mutation.isPending}
                onClick={() => mutation.mutate("delete")}
              >
                确认删除
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => setDeleting(false)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {mutation.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

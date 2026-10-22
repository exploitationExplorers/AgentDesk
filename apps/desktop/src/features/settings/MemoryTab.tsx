import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Trash2 } from "lucide-react";
import type { Memory, MemoryKind } from "@agentdesk/shared";
import { Badge, Button, Card } from "@agentdesk/ui";
import { api } from "../../lib/api";

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: "偏好",
  fact: "事实",
  decision: "决定",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function MemoryTab() {
  const queryClient = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ["memories"], queryFn: api.memories });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">
        对话里说「记住……」会写入这里；助手也会记下稳定的偏好、事实和决定，并在以后的对话里召回。删除需要在对话中确认，这里可以直接删。
      </p>
      {isLoading ? null : data.length === 0 ? (
        <p className="text-[13px] text-subtle">还没有长期记忆。</p>
      ) : (
        <Card>
          {data.map((item) => (
            <MemoryRow key={item.id} item={item} onDelete={() => remove.mutate(item.id)} />
          ))}
        </Card>
      )}
    </div>
  );
}

function MemoryRow({ item, onDelete }: { item: Memory; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
      <Brain className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="brand">{KIND_LABEL[item.kind]}</Badge>
          <Badge>{item.source === "auto" ? "自动" : "手动"}</Badge>
          <span className="text-[11.5px] text-subtle">{formatTime(item.updatedAt)}</span>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed">{item.text}</p>
      </div>
      <Button size="icon" variant="ghost" onClick={onDelete} aria-label="删除记忆">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

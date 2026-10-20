import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentModelBinding, AgentName } from "@agentdesk/shared";
import { Button, Card, Input, Select } from "@agentdesk/ui";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";

const AGENTS = Object.keys(AGENT_META) as AgentName[];

export function BindingsTab() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const bindings = useQuery({ queryKey: ["bindings"], queryFn: api.bindings });
  const [draft, setDraft] = useState<
    Record<string, { providerId: string; model: string; fallback: string }>
  >({});

  useEffect(() => {
    if (!bindings.data) return;
    setDraft(
      Object.fromEntries(
        bindings.data.map((b) => [
          b.agent,
          { providerId: b.providerId, model: b.model, fallback: b.fallbackProviderIds[0] ?? "" },
        ]),
      ),
    );
  }, [bindings.data]);

  const save = useMutation({
    mutationFn: () => {
      const list: AgentModelBinding[] = Object.entries(draft)
        .filter(([, v]) => v.providerId && v.model)
        .map(([agent, v]) => ({
          agent: agent as AgentName,
          providerId: v.providerId,
          model: v.model,
          fallbackProviderIds: v.fallback ? [v.fallback] : [],
        }));
      return api.setBindings(list);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bindings"] }),
  });

  const list = providers.data ?? [];
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">
        为每个 Agent 指定模型，例如研究 Agent 用便宜的模型批量写摘要，部署 Agent
        用支持图片的模型做视觉兜底。未配置时使用总控 Agent 的设置，再退回第一个可用 Provider。
      </p>
      <Card>
        <div className="grid grid-cols-[160px_1fr_1fr_1fr] gap-3 border-b px-4 py-2 text-[11.5px] font-medium text-subtle">
          <span>Agent</span>
          <span>Provider</span>
          <span>模型</span>
          <span>备用 Provider</span>
        </div>
        {AGENTS.map((agent) => {
          const meta = AGENT_META[agent];
          const value = draft[agent] ?? { providerId: "", model: "", fallback: "" };
          const provider = list.find((p) => p.id === value.providerId);
          const update = (patch: Partial<typeof value>) =>
            setDraft({ ...draft, [agent]: { ...value, ...patch } });
          return (
            <div
              key={agent}
              className="grid grid-cols-[160px_1fr_1fr_1fr] items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <meta.icon className="h-4 w-4 text-muted" />
                {meta.label}
              </div>
              <Select
                value={value.providerId}
                onChange={(e) => {
                  const p = list.find((x) => x.id === e.target.value);
                  update({ providerId: e.target.value, model: p?.defaultModel ?? "" });
                }}
              >
                <option value="">（默认）</option>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Input
                list={`models-${agent}`}
                value={value.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="模型 ID"
              />
              <datalist id={`models-${agent}`}>
                {provider?.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Select value={value.fallback} onChange={(e) => update({ fallback: e.target.value })}>
                <option value="">（自动）</option>
                {list
                  .filter((p) => p.id !== value.providerId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </div>
          );
        })}
      </Card>
      <div>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          保存绑定
        </Button>
        {save.isSuccess ? <span className="ml-3 text-[12px] text-success">已保存</span> : null}
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, KeyRound, Plus, Trash2, XCircle, Zap } from "lucide-react";
import { useState } from "react";
import {
  ModelLimits,
  type Provider,
  type ProviderApi,
  type ProviderCandidate,
} from "@agentdesk/shared";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Segmented,
  Spinner,
} from "@agentdesk/ui";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { api } from "../../lib/api";

const SOURCE_LABEL = { manual: "手动", dotenv: ".env", "cc-switch": "CC Switch" } as const;
const CONTEXT_PRESETS = [32768, 65536, 131072, 200000, 1000000] as const;
const formatTokens = (value: number) => value.toLocaleString("en-US");

function ProviderDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  provider?: Provider;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: provider?.name ?? "",
    api: (provider?.api ?? "openai-completions") as ProviderApi,
    baseUrl: provider?.baseUrl ?? "",
    models: provider?.models.join(", ") ?? "",
    apiKey: "",
  });
  const [limits, setLimits] = useState<
    Record<string, { contextWindow: string; maxOutputTokens: string }>
  >(() =>
    Object.fromEntries(
      Object.entries(provider?.modelLimits ?? {}).map(([model, value]) => [
        model,
        {
          contextWindow: String(value.contextWindow),
          maxOutputTokens: String(value.maxOutputTokens),
        },
      ]),
    ),
  );
  const currentModels = [...new Set(form.models.split(/[,\s]+/).filter(Boolean))];
  const updateLimit = (model: string, key: "contextWindow" | "maxOutputTokens", value: string) => {
    setLimits((previous) => ({
      ...previous,
      [model]: {
        contextWindow: previous[model]?.contextWindow ?? "",
        maxOutputTokens: previous[model]?.maxOutputTokens ?? "",
        [key]: value,
      },
    }));
  };
  const save = useMutation({
    mutationFn: () => {
      const models = currentModels;
      const modelLimits: Record<string, ModelLimits> = {};
      for (const [model, value] of Object.entries(limits)) {
        if (!value.contextWindow && !value.maxOutputTokens) continue;
        const parsed = ModelLimits.safeParse({
          contextWindow: Number(value.contextWindow || 32768),
          maxOutputTokens: Number(value.maxOutputTokens || 4096),
        });
        if (!parsed.success)
          throw new Error(
            `${model}：上下文窗口需为 4,096–2,000,000 的整数，输出上限需为 256–200,000 的整数，且小于窗口的一半。`,
          );
        modelLimits[model] = parsed.data;
      }
      const payload = {
        name: form.name,
        api: form.api,
        baseUrl: form.baseUrl,
        models,
        defaultModel: models[0] ?? "",
        modelLimits,
        source: provider?.source ?? ("manual" as const),
        enabled: provider?.enabled ?? true,
        apiKey: form.apiKey || undefined,
      };
      return provider ? api.updateProvider(provider.id, payload) : api.createProvider(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["session-workbench"] });
      onOpenChange(false);
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const remote = useQuery({
    queryKey: ["remote-models", provider?.id],
    queryFn: () => api.remoteModels(provider!.id),
    enabled: false,
    retry: false,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `编辑 ${provider.name}` : "添加模型 Provider"}
      description="支持 OpenAI 兼容接口（含各类中转站）和 Anthropic Messages 接口。密钥加密保存在本机。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate()}
            disabled={!form.name || !form.baseUrl || !form.models}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="名称">
          <Input value={form.name} onChange={set("name")} placeholder="例如：Claude 中转站" />
        </Field>
        <Field label="接口协议">
          <Segmented
            value={form.api}
            onChange={(v) => setForm({ ...form, api: v })}
            options={[
              { value: "openai-completions", label: "OpenAI 兼容" },
              { value: "anthropic-messages", label: "Anthropic" },
            ]}
          />
        </Field>
        <Field
          label="Base URL"
          hint={
            form.api === "anthropic-messages"
              ? "例如 https://api.anthropic.com（不带 /v1）"
              : "例如 https://api.openai.com/v1"
          }
        >
          <Input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://" />
        </Field>
        <Field label="模型（逗号分隔，第一个为默认）">
          <div className="flex gap-2">
            <Input
              value={form.models}
              onChange={set("models")}
              placeholder="claude-sonnet-4-5, claude-opus-4-1"
            />
            {provider?.hasKey ? (
              <Button
                variant="secondary"
                loading={remote.isFetching}
                onClick={() => void remote.refetch()}
              >
                获取可用模型
              </Button>
            ) : null}
          </div>
        </Field>
        {remote.error ? (
          <p className="-mt-2 text-[12px] text-danger">{remote.error.message}</p>
        ) : null}
        {remote.data?.length ? (
          <div className="-mt-2 flex flex-wrap gap-1.5">
            {remote.data.map((m) => {
              const selected = form.models.split(/[,\s]+/).includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    const list = form.models.split(/[,\s]+/).filter(Boolean);
                    setForm({
                      ...form,
                      models: (selected ? list.filter((x) => x !== m) : [...list, m]).join(", "),
                    });
                  }}
                  className={
                    selected
                      ? "rounded-full bg-brand/15 px-2 py-0.5 font-mono text-[11px] text-brand"
                      : "rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted hover:text-fg"
                  }
                >
                  {m}
                </button>
              );
            })}
          </div>
        ) : null}
        {currentModels.length > 0 ? (
          <section aria-label="模型容量设置" className="rounded-xl border p-3">
            <h3 className="text-[13px] font-medium">上下文与输出上限</h3>
            <p className="mt-2 text-[12px] text-muted">
              按服务商实际支持的容量设置，单位为 token。留空时使用 32,768 的上下文窗口和 4,096
              的输出上限。调大此值可减少长任务中断，但不能超过服务商限制。
            </p>
            <div className="mt-3 grid max-h-64 gap-4 overflow-y-auto">
              {currentModels.map((model) => {
                const capacity = ModelLimits.safeParse({
                  contextWindow: Number(limits[model]?.contextWindow || 32768),
                  maxOutputTokens: Number(limits[model]?.maxOutputTokens || 4096),
                });
                return (
                  <div key={model} className="grid gap-2">
                    <p className="break-all font-mono text-[12px]">{model}</p>
                    <div
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label={`${model} 快捷容量`}
                    >
                      {CONTEXT_PRESETS.map((value) => (
                        <Button
                          key={value}
                          size="sm"
                          variant={
                            Number(limits[model]?.contextWindow || 32768) === value
                              ? "secondary"
                              : "outline"
                          }
                          onClick={() => updateLimit(model, "contextWindow", String(value))}
                        >
                          {value === 200000 ? "200K" : value < 1000000 ? `${value / 1024}K` : "1M"}
                        </Button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="最大上下文">
                        <Input
                          aria-label={`${model} 上下文窗口`}
                          type="number"
                          min={4096}
                          max={2000000}
                          step={1}
                          value={limits[model]?.contextWindow ?? ""}
                          placeholder="32768"
                          onChange={(event) =>
                            updateLimit(model, "contextWindow", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="最大输出">
                        <Input
                          aria-label={`${model} 最大输出`}
                          type="number"
                          min={256}
                          max={200000}
                          step={1}
                          value={limits[model]?.maxOutputTokens ?? ""}
                          placeholder="4096"
                          onChange={(event) =>
                            updateLimit(model, "maxOutputTokens", event.target.value)
                          }
                        />
                      </Field>
                    </div>
                    <p
                      className={`text-[12px] ${capacity.success ? "text-muted" : "text-danger"}`}
                      aria-live="polite"
                    >
                      {capacity.success
                        ? `实际输入预算约 ${formatTokens(Math.floor(capacity.data.contextWindow * 0.9) - capacity.data.maxOutputTokens)} tokens（已预留输出和安全余量）。`
                        : "请填写有效容量，最大输出需小于上下文窗口的一半。"}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <Field label="API Key" hint={provider?.hasKey ? "已保存密钥，留空表示不修改" : undefined}>
          <Input
            type="password"
            value={form.apiKey}
            onChange={set("apiKey")}
            placeholder={provider?.hasKey ? "••••••••" : "sk-..."}
          />
        </Field>
        {save.error ? <p className="text-[12px] text-danger">{save.error.message}</p> : null}
      </div>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<"cc-switch" | "dotenv">("cc-switch");
  const [path, setPath] = useState("D:\\AI agent\\langsmith\\.env");
  const [selected, setSelected] = useState<string[]>([]);
  const scan = useMutation({
    mutationFn: () => api.importCandidates(source, source === "dotenv" ? path : undefined),
    onSuccess: (list) => setSelected(list.map((c) => c.candidateId)),
  });
  const confirm = useMutation({
    mutationFn: () => api.importProviders(source, selected, source === "dotenv" ? path : undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onOpenChange(false);
    },
  });
  const candidates: ProviderCandidate[] = scan.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="导入已有的 Key"
      description="只读取配置文件，密钥不会经过界面传输；确认后加密保存到本机。"
      className="w-[min(640px,92vw)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={selected.length === 0}
            loading={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            导入 {selected.length} 个
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Segmented
          value={source}
          onChange={(v) => {
            setSource(v);
            scan.reset();
          }}
          options={[
            { value: "cc-switch", label: "CC Switch（Claude 中转站）" },
            { value: "dotenv", label: ".env 文件" },
          ]}
        />
        {source === "dotenv" ? (
          <Field
            label=".env 文件路径"
            hint="识别 *_API_KEY / *_BASE_URL / *_MODEL，自动跳过 LangSmith 等非模型 Key"
          >
            <Input value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
        ) : (
          <p className="text-[12.5px] text-muted">
            读取 ~/.cc-switch 下的 cc-switch.db 或 config.json，包含 Claude 和 Codex 的 Provider。
          </p>
        )}
        <Button
          variant="secondary"
          onClick={() => scan.mutate()}
          loading={scan.isPending}
          className="justify-self-start"
        >
          <Download className="h-3.5 w-3.5" />
          扫描
        </Button>
        {scan.error ? <p className="text-[12px] text-danger">{scan.error.message}</p> : null}
        {scan.isSuccess && candidates.length === 0 ? (
          <p className="text-[12.5px] text-muted">没有找到可导入的模型 Key。</p>
        ) : null}
        <div className="grid gap-2">
          {candidates.map((c) => {
            const checked = selected.includes(c.candidateId);
            return (
              <label
                key={c.candidateId}
                className="flex cursor-pointer items-center gap-3 rounded-xl border bg-surface-2/50 px-3 py-2.5 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setSelected(
                      checked
                        ? selected.filter((s) => s !== c.candidateId)
                        : [...selected, c.candidateId],
                    )
                  }
                  className="accent-[var(--ad-brand)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{c.name}</span>
                    <Badge tone="neutral">
                      {c.api === "anthropic-messages" ? "Anthropic" : "OpenAI 兼容"}
                    </Badge>
                    {c.model ? <Badge tone="brand">{c.model}</Badge> : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11.5px] text-subtle">
                    {c.baseUrl} · {c.maskedKey}
                  </p>
                </div>
              </label>
            );
          })}
        </div>
        {confirm.error ? <p className="text-[12px] text-danger">{confirm.error.message}</p> : null}
      </div>
    </Dialog>
  );
}

function ProviderRow({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testProvider(provider.id) });
  const toggle = useMutation({
    mutationFn: () => api.updateProvider(provider.id, { enabled: !provider.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProvider(provider.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-4 last:border-b-0">
      <ModelBrandIcon
        model={provider.defaultModel}
        baseUrl={provider.baseUrl}
        api={provider.api}
        size={28}
      />
      <button
        type="button"
        className="min-w-0 flex-1 basis-[calc(100%-52px)] rounded-lg text-left xl:basis-[200px]"
        onClick={onEdit}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{provider.name}</span>
          <Badge>{provider.api === "anthropic-messages" ? "Anthropic" : "OpenAI 兼容"}</Badge>
          <Badge tone="neutral">{SOURCE_LABEL[provider.source]}</Badge>
          {!provider.hasKey ? <Badge tone="danger">缺少 Key</Badge> : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-subtle">
          {provider.baseUrl} · {provider.defaultModel}
        </p>
      </button>
      {test.data ? (
        <span
          className={`max-w-[220px] truncate text-[12px] ${test.data.ok ? "text-success" : "text-danger"}`}
          title={test.data.error ?? test.data.reply}
        >
          <span className="inline-flex items-center gap-1">
            {test.data.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="h-3.5 w-3.5 shrink-0" />
            )}
            {test.data.ok
              ? `${test.data.latencyMs}ms`
              : (test.data.error?.replace(/^模型调用失败：/, "").slice(0, 48) ?? "失败")}
          </span>
        </span>
      ) : null}
      <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>
        <Zap className="h-3.5 w-3.5" />
        测试
      </Button>
      <Button
        size="sm"
        variant={provider.enabled ? "outline" : "ghost"}
        onClick={() => toggle.mutate()}
      >
        {provider.enabled ? "已启用" : "已停用"}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => confirm(`删除 ${provider.name}？`) && remove.mutate()}
        aria-label="删除"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function ProvidersTab() {
  const { data, isLoading } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="text-[13px] text-muted">
          按顺序作为备用：主模型失败时自动切换到下一个可用 Provider。
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={() => setImporting(true)}>
            <Download className="h-3.5 w-3.5" />
            导入 Key
          </Button>
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : data?.length ? (
        <Card>
          {data.map((p) => (
            <ProviderRow key={p.id} provider={p} onEdit={() => setEditing(p)} />
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={<KeyRound className="h-6 w-6" />}
          title="还没有模型 Provider"
          description="从 CC Switch 或 langsmith 项目的 .env 一键导入你已有的 Key 和中转地址。"
          action={
            <Button variant="primary" onClick={() => setImporting(true)}>
              导入已有 Key
            </Button>
          }
        />
      )}
      {editing ? (
        <ProviderDialog
          open
          onOpenChange={(o) => !o && setEditing(null)}
          provider={editing === "new" ? undefined : editing}
        />
      ) : null}
      {importing ? <ImportDialog open onOpenChange={setImporting} /> : null}
    </div>
  );
}

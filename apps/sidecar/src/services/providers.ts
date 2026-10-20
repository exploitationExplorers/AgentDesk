import {
  buildModel,
  completeText,
  type ModelResolver,
  type ResolvedModel,
} from "@agentdesk/agent-core";
import {
  detectProxyFromCcSwitch,
  importFromCcSwitch,
  importFromDotenvFile,
  toPublicCandidate,
  type RawProviderCandidate,
} from "@agentdesk/integrations";
import {
  AgentModelBinding,
  AppError,
  ErrorCode,
  ProviderInput,
  type AgentName,
  type Provider,
  type ProviderCandidate,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { readExternalSqlite } from "../db/client";
import { Collection } from "../db/collection";
import { applyProxy, resolveProxy } from "../proxy";
import type { SecretStore } from "../secrets";
import { errorMessage, newId, nowIso } from "../util";
import type { SettingsService } from "./settings";

type StoredProvider = Omit<Provider, "hasKey">;
type BindingDoc = AgentModelBinding & { id: string };

const secretId = (providerId: string) => `provider:${providerId}`;

export class ProviderService implements ModelResolver {
  private readonly providers: Collection<StoredProvider>;
  private readonly bindings: Collection<BindingDoc>;

  constructor(
    db: Db,
    private readonly secrets: SecretStore,
    private readonly settings?: SettingsService,
  ) {
    this.providers = new Collection<StoredProvider>(db, "providers");
    this.bindings = new Collection<BindingDoc>(db, "agentBindings");
  }

  private present(p: StoredProvider): Provider {
    return { ...p, hasKey: this.secrets.has(secretId(p.id)) };
  }

  list(): Provider[] {
    return this.providers
      .list()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => this.present(p));
  }

  get(id: string): Provider {
    const p = this.providers.get(id);
    if (!p) throw new AppError(ErrorCode.NotFound, "Provider 不存在");
    return this.present(p);
  }

  create(input: unknown): Provider {
    const data = ProviderInput.parse(input);
    const { apiKey, ...rest } = data;
    const stored: StoredProvider = { id: newId(), ...rest, createdAt: nowIso() };
    this.providers.put(stored);
    if (apiKey) this.secrets.set(secretId(stored.id), apiKey);
    return this.present(stored);
  }

  update(id: string, input: unknown): Provider {
    const current = this.providers.get(id);
    if (!current) throw new AppError(ErrorCode.NotFound, "Provider 不存在");
    const data = ProviderInput.partial().parse(input);
    const { apiKey, ...rest } = data;
    const next = this.providers.put({ ...current, ...rest });
    if (apiKey) this.secrets.set(secretId(id), apiKey);
    return this.present(next);
  }

  delete(id: string): void {
    this.providers.delete(id);
    this.secrets.delete(secretId(id));
    for (const b of this.bindings.list()) {
      if (b.providerId === id) this.bindings.delete(b.id);
    }
  }

  // ---------- 导入 ----------

  private async scan(
    source: "dotenv" | "cc-switch",
    path?: string,
  ): Promise<RawProviderCandidate[]> {
    if (source === "dotenv") {
      if (!path) throw new AppError(ErrorCode.BadRequest, "请选择 .env 文件路径");
      try {
        return await importFromDotenvFile(path);
      } catch (error) {
        throw new AppError(ErrorCode.BadRequest, `读取 .env 失败：${errorMessage(error)}`);
      }
    }
    return importFromCcSwitch(readExternalSqlite, path);
  }

  async candidates(source: "dotenv" | "cc-switch", path?: string): Promise<ProviderCandidate[]> {
    return (await this.scan(source, path)).map(toPublicCandidate);
  }

  /** 确认导入：重新读取源文件拿到明文 key，不经过 UI 传输。 */
  async import(
    source: "dotenv" | "cc-switch",
    candidateIds: string[],
    path?: string,
  ): Promise<Provider[]> {
    const raw = await this.scan(source, path);
    const existing = this.list();
    const created: Provider[] = [];
    for (const c of raw.filter((r) => candidateIds.includes(r.candidateId))) {
      const base = c.baseUrl.replace(/\/+$/, "");
      // 「Claude Code 当前配置」覆盖同中转站已导入的 Anthropic Provider，避免沿用 CC Switch 库里的旧 Key
      const isActiveClaude = c.name.includes("当前配置") || /[/\\]\.claude[/\\]settings\.json$/i.test(c.origin);
      const duplicate =
        existing.find((p) => p.baseUrl === base && p.name === c.name) ??
        (isActiveClaude
          ? existing.find((p) => p.baseUrl === base && p.api === c.api && p.source === "cc-switch")
          : undefined);
      const model =
        c.model ?? (c.api === "anthropic-messages" ? "claude-sonnet-4-5" : "gpt-4o-mini");
      const payload = {
        name: c.name,
        api: c.api,
        baseUrl: c.baseUrl.replace(/\/+$/, ""),
        models: [model],
        defaultModel: model,
        source: c.source,
        enabled: true,
        apiKey: c.apiKey,
      };
      const saved = duplicate ? this.update(duplicate.id, payload) : this.create(payload);
      created.push(saved);
      if (!duplicate) existing.push(saved);
      else Object.assign(duplicate, saved);
    }
    if (source === "cc-switch") await this.syncProxyFromCcSwitch();
    return created;
  }

  /** 导入 CC Switch 时顺带带上它的 HTTPS_PROXY，避免直连中转站一直转圈。 */
  private async syncProxyFromCcSwitch(): Promise<void> {
    if (!this.settings) return;
    const current = this.settings.get().proxy?.trim();
    if (current) return;
    const proxy = await detectProxyFromCcSwitch(readExternalSqlite);
    if (!proxy) return;
    const next = this.settings.update({ proxy });
    applyProxy(resolveProxy(next.proxy));
  }

  async test(
    id: string,
  ): Promise<{ ok: boolean; latencyMs: number; reply?: string; error?: string }> {
    const provider = this.get(id);
    const apiKey = this.secrets.get(secretId(id));
    if (!apiKey) return { ok: false, latencyMs: 0, error: "未配置 API Key" };
    const started = Date.now();
    try {
      const reply = await completeText({
        models: [
          {
            providerId: id,
            providerName: provider.name,
            model: buildModel(provider, provider.defaultModel),
            apiKey,
          },
        ],
        systemPrompt: "You are a health check.",
        prompt: "Reply with the single word: pong",
        maxTokens: 16,
        signal: AbortSignal.timeout(30_000),
      });
      return { ok: true, latencyMs: Date.now() - started, reply: reply.trim().slice(0, 60) };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: errorMessage(error) };
    }
  }

  /** 从中转站/官方接口拉取可用模型列表（OpenAI 兼容的 /models 或 Anthropic 的 /v1/models）。 */
  async remoteModels(id: string): Promise<string[]> {
    const provider = this.get(id);
    const apiKey = this.secrets.get(secretId(id));
    if (!apiKey) throw new AppError(ErrorCode.BadRequest, "未配置 API Key");
    const base = provider.baseUrl.replace(/\/+$/, "");
    const url =
      provider.api === "anthropic-messages"
        ? `${base.replace(/\/v1$/, "")}/v1/models`
        : `${base}/models`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new AppError(
        ErrorCode.ProviderUnavailable,
        `获取模型列表失败：HTTP ${response.status}`,
      );
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return [...new Set((body.data ?? []).map((m) => m.id).filter((m): m is string => !!m))].sort();
  }

  // ---------- Agent 模型绑定 ----------

  listBindings(): AgentModelBinding[] {
    return this.bindings.list().map(({ id: _id, ...b }) => b);
  }

  setBindings(input: unknown): AgentModelBinding[] {
    const list = AgentModelBinding.array().parse(input);
    for (const existing of this.bindings.list()) this.bindings.delete(existing.id);
    for (const b of list) this.bindings.put({ id: b.agent, ...b });
    return this.listBindings();
  }

  private toResolved(provider: Provider, model: string): ResolvedModel | null {
    if (!provider.enabled) return null;
    const apiKey = this.secrets.get(secretId(provider.id));
    if (!apiKey) return null;
    return {
      providerId: provider.id,
      providerName: provider.name,
      model: buildModel(provider, model),
      apiKey,
    };
  }

  /**
   * 解析顺序：Agent 专属绑定 → 绑定中的备用 Provider → 其余已启用 Provider（按创建顺序）。
   * 返回的列表即模型调用时的故障切换顺序。
   */
  async resolve(agent: AgentName): Promise<ResolvedModel[]> {
    const providers = this.list();
    const byId = new Map(providers.map((p) => [p.id, p]));
    const binding = this.bindings.get(agent) ?? this.bindings.get("orchestrator");
    const ordered: Array<{ provider: Provider; model: string }> = [];

    if (binding) {
      const primary = byId.get(binding.providerId);
      if (primary) ordered.push({ provider: primary, model: binding.model });
      for (const fid of binding.fallbackProviderIds) {
        const p = byId.get(fid);
        if (p) ordered.push({ provider: p, model: p.defaultModel });
      }
    }
    for (const p of providers) {
      if (!ordered.some((o) => o.provider.id === p.id))
        ordered.push({ provider: p, model: p.defaultModel });
    }
    return ordered
      .map((o) => this.toResolved(o.provider, o.model))
      .filter((m): m is ResolvedModel => m !== null);
  }
}

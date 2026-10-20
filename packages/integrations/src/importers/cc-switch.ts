import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawProviderCandidate } from "./types";

export function ccSwitchDir(): string {
  return join(homedir(), ".cc-switch");
}

interface CcProvider {
  id?: string;
  name?: string;
  appType?: string;
  settingsConfig?: unknown;
}

/** sqlite 读取由宿主注入（sidecar 使用 better-sqlite3），保持本包与运行时无关。 */
export type SqliteReader = (dbPath: string, sql: string) => Array<Record<string, unknown>>;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function tomlValue(toml: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(toml)?.[1];
}

/** 把一个 CC Switch provider 转成候选：claude 走 Anthropic 协议，codex 走 OpenAI 协议。 */
export function candidateFromCcProvider(
  p: CcProvider,
  origin: string,
): RawProviderCandidate | null {
  const settings = asRecord(p.settingsConfig);
  const env = asRecord(settings.env);
  const name = p.name ?? p.id ?? "CC Switch";

  const anthropicKey = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "");
  if (anthropicKey) {
    return {
      candidateId: `cc-switch:${origin}:${p.appType ?? "claude"}:${p.id ?? name}`,
      name: `${name} (Claude)`,
      api: "anthropic-messages",
      baseUrl: String(env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"),
      model: (env.ANTHROPIC_MODEL as string | undefined) ?? undefined,
      apiKey: anthropicKey,
      source: "cc-switch",
      origin,
    };
  }

  const auth = asRecord(settings.auth);
  const openaiKey = String(auth.OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? "");
  if (openaiKey) {
    const toml = typeof settings.config === "string" ? settings.config : "";
    return {
      candidateId: `cc-switch:${origin}:${p.appType ?? "codex"}:${p.id ?? name}`,
      name: `${name} (Codex)`,
      api: "openai-completions",
      baseUrl:
        tomlValue(toml, "base_url") ?? String(env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      model: tomlValue(toml, "model"),
      apiKey: openaiKey,
      source: "cc-switch",
      origin,
    };
  }
  return null;
}

function providersFromConfigJson(json: Record<string, unknown>): CcProvider[] {
  const out: CcProvider[] = [];
  const collect = (section: unknown, appType: string) => {
    const providers = asRecord(asRecord(section).providers);
    for (const [id, value] of Object.entries(providers)) {
      const p = asRecord(value);
      out.push({ id, name: p.name as string, appType, settingsConfig: p.settingsConfig });
    }
  };
  if (json.claude || json.codex) {
    collect(json.claude, "claude");
    collect(json.codex, "codex");
  } else {
    collect(json, "claude");
  }
  return out;
}

/** Claude Code 当前生效的 settings.json（CC Switch 切换后会写入这里）。 */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * 读取 Claude Code 当前正在使用的 Key / Base URL。
 * CC Switch 数据库里的 Provider 可能与当前生效配置不同步，优先用这份。
 */
export async function candidateFromActiveClaudeSettings(
  path = claudeSettingsPath(),
): Promise<RawProviderCandidate | null> {
  if (!existsSync(path)) return null;
  try {
    const json = asRecord(JSON.parse(await readFile(path, "utf8")));
    const env = asRecord(json.env);
    const apiKey = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "");
    const baseUrl = String(env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "");
    if (!apiKey || !baseUrl) return null;
    return {
      candidateId: `cc-switch:active-claude:${baseUrl}`,
      name: "Claude Code 当前配置",
      api: "anthropic-messages",
      baseUrl,
      model: (env.ANTHROPIC_MODEL as string | undefined) ?? undefined,
      apiKey,
      source: "cc-switch",
      origin: path,
    };
  } catch {
    return null;
  }
}

/** 从 CC Switch / Claude settings 里收集 HTTPS_PROXY（Claude Code 能通、AgentDesk 不通时多半差这个）。 */
export async function detectProxyFromCcSwitch(
  readSqlite?: SqliteReader,
  dir = ccSwitchDir(),
): Promise<string | null> {
  const pick = (value: unknown) => {
    const s = String(value ?? "").trim();
    return /^https?:\/\//i.test(s) ? s : null;
  };

  const settingsPath = claudeSettingsPath();
  if (existsSync(settingsPath)) {
    try {
      const env = asRecord(asRecord(JSON.parse(await readFile(settingsPath, "utf8"))).env);
      const proxy = pick(env.HTTPS_PROXY ?? env.HTTP_PROXY);
      if (proxy) return proxy;
    } catch {
      // ignore
    }
  }

  const dbPath = join(dir, "cc-switch.db");
  if (readSqlite && existsSync(dbPath)) {
    try {
      for (const row of readSqlite(dbPath, "SELECT settings_config FROM providers")) {
        const env = asRecord(asRecord(row.settings_config ?? row.settingsConfig).env);
        const proxy = pick(env.HTTPS_PROXY ?? env.HTTP_PROXY);
        if (proxy) return proxy;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 兼容 CC Switch 的两种存储：
 * - v3.x 早期：~/.cc-switch/config.json
 * - 新版：~/.cc-switch/cc-switch.db（providers 表）
 * - 额外：~/.claude/settings.json（当前 Claude Code 真正在用的配置，优先展示）
 */
export async function importFromCcSwitch(
  readSqlite?: SqliteReader,
  dir = ccSwitchDir(),
): Promise<RawProviderCandidate[]> {
  const providers: Array<{ p: CcProvider; origin: string }> = [];

  const dbPath = join(dir, "cc-switch.db");
  if (readSqlite && existsSync(dbPath)) {
    try {
      for (const row of readSqlite(dbPath, "SELECT * FROM providers")) {
        providers.push({
          origin: dbPath,
          p: {
            id: String(row.id ?? ""),
            name: String(row.name ?? row.id ?? ""),
            appType: String(row.app_type ?? row.app ?? "claude"),
            settingsConfig: row.settings_config ?? row.settingsConfig,
          },
        });
      }
    } catch {
      // 表结构不同或文件被占用，继续尝试 JSON
    }
  }

  const jsonPath = join(dir, "config.json");
  if (existsSync(jsonPath)) {
    try {
      const json = asRecord(JSON.parse(await readFile(jsonPath, "utf8")));
      for (const p of providersFromConfigJson(json)) providers.push({ p, origin: jsonPath });
    } catch {
      // 配置损坏时忽略
    }
  }

  const seen = new Set<string>();
  const fromStore = providers
    .map(({ p, origin }) => candidateFromCcProvider(p, origin))
    .filter((c): c is RawProviderCandidate => {
      if (!c) return false;
      const key = `${c.baseUrl}|${c.apiKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const active = await candidateFromActiveClaudeSettings();
  if (active) {
    const key = `${active.baseUrl}|${active.apiKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      return [active, ...fromStore];
    }
    // Key 已在库里：把对应项挪到最前并改名为当前配置，方便用户识别
    const idx = fromStore.findIndex((c) => `${c.baseUrl}|${c.apiKey}` === key);
    if (idx >= 0) {
      const [hit] = fromStore.splice(idx, 1);
      return [{ ...hit!, name: "Claude Code 当前配置", origin: active.origin }, ...fromStore];
    }
  }
  return fromStore;
}

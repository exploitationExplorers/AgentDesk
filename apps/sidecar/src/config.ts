import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SidecarConfig {
  version: string;
  host: string;
  port: number;
  /** UI 与 sidecar 之间的会话令牌；为空表示开发模式不校验 */
  token: string | null;
  dataDir: string;
  /** base64 编码的 32 字节主密钥，由 Tauri 从系统钥匙串读取后注入 */
  masterKey: string | null;
  skillDirs: string[];
  allowedOrigins: string[];
}

function defaultDataDir(): string {
  if (process.platform === "win32" && process.env.APPDATA)
    return join(process.env.APPDATA, "AgentDesk");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "AgentDesk");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "AgentDesk");
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const dataDir = resolve(env.AGENTDESK_DATA_DIR ?? defaultDataDir());
  mkdirSync(dataDir, { recursive: true });
  const builtInSkills = env.AGENTDESK_SKILLS_DIR ?? resolve(here, "..", "skills");
  return {
    version: env.AGENTDESK_VERSION ?? "0.1.0",
    host: "127.0.0.1",
    port: Number(env.AGENTDESK_PORT ?? 17890),
    token: env.AGENTDESK_TOKEN || null,
    dataDir,
    masterKey: env.AGENTDESK_MASTER_KEY || null,
    skillDirs: [builtInSkills, join(dataDir, "skills")],
    allowedOrigins: [
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://localhost:1420",
      "http://127.0.0.1:1420",
      ...(env.AGENTDESK_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ],
  };
}

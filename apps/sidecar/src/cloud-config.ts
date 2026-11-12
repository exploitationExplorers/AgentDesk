import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SidecarConfig } from "./config";
import { RemoteId } from "@agentdesk/shared";
import { z } from "zod";

export interface CloudConfig extends SidecarConfig {
  kind?: "cloud" | "office";
  hostId: string;
  name: string;
  workspaceRoot: string;
  remoteToken: string;
  taskTimeoutMs: number;
  ownerUserId: string;
  allowedProviderHosts: string[];
  allowServerProviderCredentials?: boolean;
  databaseUrl?: string;
  databaseSchema?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function requiredFile(path: string, name: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  if (env.DATABASE_URL && env.DATABASE_URL_FILE)
    throw new Error("Configure only one Runner database URL source");
  const databaseUrl = env.DATABASE_URL_FILE
    ? readFileSync(env.DATABASE_URL_FILE, "utf8").trim()
    : env.DATABASE_URL;
  if (env.DATABASE_URL !== undefined || env.DATABASE_URL_FILE !== undefined) {
    try {
      const url = new URL(databaseUrl ?? "");
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.hostname ||
        url.pathname.length < 2 ||
        url.searchParams.has("options")
      )
        throw new Error();
    } catch {
      throw new Error("Invalid Runner PostgreSQL configuration");
    }
  }
  const databaseSchema = env.DATABASE_SCHEMA ?? "runner";
  if (env.NODE_ENV === "production" && !databaseUrl)
    throw new Error("Production cloud Runner requires PostgreSQL");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseSchema))
    throw new Error("Invalid Runner database schema");
  if (env.DATABASE_SCHEMA !== undefined && !databaseUrl)
    throw new Error("Runner database schema requires a PostgreSQL URL");
  const dataDir = resolve(env.AGENTDESK_DATA_DIR ?? "/var/lib/agentdesk-cloud");
  const workspaceRoot = resolve(env.WORKSPACE_ROOT ?? "");
  const masterKeyFile = resolve(env.AGENTDESK_MASTER_KEY_FILE ?? "");
  const remoteTokenFile = resolve(env.REMOTE_SHARED_TOKEN_FILE ?? "");
  if (!env.WORKSPACE_ROOT || !env.AGENTDESK_MASTER_KEY_FILE || !env.REMOTE_SHARED_TOKEN_FILE)
    throw new Error(
      "WORKSPACE_ROOT, AGENTDESK_MASTER_KEY_FILE, and REMOTE_SHARED_TOKEN_FILE are required",
    );
  if (!env.CLOUD_OWNER_USER_ID?.trim()) throw new Error("CLOUD_OWNER_USER_ID is required");
  if (!statSync(workspaceRoot).isDirectory()) throw new Error("WORKSPACE_ROOT must be a directory");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const masterKey = requiredFile(masterKeyFile, "Master key");
  if (
    Buffer.from(masterKey, "base64").length !== 32 ||
    Buffer.from(masterKey, "base64").toString("base64") !== masterKey
  )
    throw new Error("Master key file must contain a base64 encoded 32-byte key");
  return {
    databaseUrl,
    databaseSchema,
    version: env.AGENTDESK_VERSION ?? "0.1.0",
    host: "0.0.0.0",
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.AGENTDESK_CLOUD_PORT ?? 17893),
    token: null,
    dataDir,
    masterKey,
    skillDirs: [env.AGENTDESK_SKILLS_DIR ?? resolve(here, "../skills"), join(dataDir, "skills")],
    wechatReportEnabled: false,
    allowedOrigins: [],
    hostId: RemoteId.parse(env.CLOUD_HOST_ID ?? "cloud"),
    name: env.CLOUD_HOST_NAME ?? "AgentDesk Cloud",
    workspaceRoot,
    remoteToken: requiredFile(remoteTokenFile, "Remote shared token"),
    taskTimeoutMs: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .parse(env.CLOUD_TASK_TIMEOUT_MS ?? 3_600_000),
    ownerUserId: RemoteId.parse(env.CLOUD_OWNER_USER_ID.trim()),
    allowServerProviderCredentials:
      z.enum(["true", "false"]).parse(env.ALLOW_SERVER_PROVIDER_CREDENTIALS ?? "false") === "true",
    allowedProviderHosts: (
      env.PROVIDER_ALLOWED_HOSTS ?? "api.openai.com,api.anthropic.com,api.deepseek.com"
    )
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}

import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { OwnerEmail, RemoteId } from "@agentdesk/shared";
import { z } from "zod";

export interface GatewayConfig {
  publicOrigin: string;
  ownerEmail: string;
  ownerUserId?: string;
  /** When true, any valid email can request OTP and first verify creates the user. */
  authMultiUser: boolean;
  dataDir: string;
  databaseUrl?: string;
  databaseSchema?: string;
  host: string;
  port: number;
  sessionSecret: string;
  otpPepper: string;
  remoteToken: string;
  runnerUrl: string;
  cloudHostName: string;
  cloudWorkspaceRoot: string;
  providerHostAllowlist: string[];
  allowServerProviderCredentials?: boolean;
  trustedProxies: BlockList;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, key: string): string {
  const value = readFileSync(required(env, key), "utf8").trim();
  if (value.length < 32 || value.length > 4096) throw new Error(`Invalid secret file: ${key}`);
  return value;
}

export function parseTrustedProxies(value: string): BlockList {
  const list = new BlockList();
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address = "", prefix, extra] = entry.split("/");
    const version = isIP(address);
    if (!version || extra) throw new Error("Invalid TRUSTED_PROXY_CIDRS");
    const family = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, family);
    else {
      const bits = z.coerce
        .number()
        .int()
        .min(1)
        .max(version === 4 ? 32 : 128)
        .parse(prefix);
      list.addSubnet(address, bits, family);
    }
  }
  return list;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const database = loadDatabaseConfig(env);
  const origin = new URL(required(env, "PUBLIC_ORIGIN"));
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin");
  const runner = new URL(required(env, "CLOUD_RUNNER_URL"));
  if (
    !["http:", "https:"].includes(runner.protocol) ||
    runner.username ||
    runner.password ||
    runner.pathname !== "/" ||
    runner.search ||
    runner.hash
  )
    throw new Error("CLOUD_RUNNER_URL must be a fixed service origin");
  const secure = required(env, "SMTP_SECURE");
  if (secure !== "true" && secure !== "false") throw new Error("SMTP_SECURE must be true or false");
  const smtpPassword = readFileSync(required(env, "SMTP_PASSWORD_FILE"), "utf8").trim();
  if (!smtpPassword) throw new Error("SMTP_PASSWORD_FILE is empty");
  const providerHostAllowlist = (
    env.PROVIDER_ALLOWED_HOSTS ?? "api.openai.com,api.anthropic.com,api.deepseek.com"
  )
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    providerHostAllowlist.some(
      (host) => !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host),
    )
  )
    throw new Error("PROVIDER_ALLOWED_HOSTS must contain exact DNS names");
  const authMultiUser = (env.AUTH_MULTI_USER ?? "true").trim().toLowerCase();
  if (authMultiUser !== "true" && authMultiUser !== "false")
    throw new Error("AUTH_MULTI_USER must be true or false");
  return {
    publicOrigin: origin.origin,
    ownerEmail: OwnerEmail.parse(required(env, "OWNER_EMAIL")),
    ...(env.CLOUD_OWNER_USER_ID ? { ownerUserId: RemoteId.parse(env.CLOUD_OWNER_USER_ID) } : {}),
    authMultiUser: authMultiUser === "true",
    dataDir: resolve(required(env, "GATEWAY_DATA_DIR")),
    ...database,
    host: env.GATEWAY_HOST ?? "127.0.0.1",
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.GATEWAY_PORT ?? "3000"),
    sessionSecret: secret(env, "SESSION_SECRET_FILE"),
    otpPepper: secret(env, "OTP_PEPPER_FILE"),
    remoteToken: secret(env, "REMOTE_SHARED_TOKEN_FILE"),
    runnerUrl: runner.origin,
    cloudHostName: env.CLOUD_HOST_NAME?.trim() || "Cloud server",
    cloudWorkspaceRoot: resolve(env.CLOUD_WORKSPACE_ROOT ?? "/workspaces"),
    providerHostAllowlist: [...new Set(providerHostAllowlist)],
    allowServerProviderCredentials:
      z.enum(["true", "false"]).parse(env.ALLOW_SERVER_PROVIDER_CREDENTIALS ?? "false") === "true",
    trustedProxies: parseTrustedProxies(required(env, "TRUSTED_PROXY_CIDRS")),
    smtp: {
      host: required(env, "SMTP_HOST"),
      port: z.coerce.number().int().min(1).max(65535).parse(required(env, "SMTP_PORT")),
      secure: secure === "true",
      user: required(env, "SMTP_USER"),
      password: smtpPassword,
      from: OwnerEmail.parse(required(env, "SMTP_FROM")),
    },
  };
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseSchema = env.DATABASE_SCHEMA ?? "gateway";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseSchema)) throw new Error("Invalid DATABASE_SCHEMA");
  if (env.DATABASE_URL_FILE === undefined) return { databaseSchema };
  let databaseUrl: string;
  try {
    databaseUrl = readFileSync(required(env, "DATABASE_URL_FILE"), "utf8").trim();
    const url = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      "Invalid DATABASE_URL_FILE; PostgreSQL configuration cannot fall back to SQLite",
    );
  }
  return { databaseSchema, databaseUrl };
}

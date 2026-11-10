import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadGatewayConfig, parseTrustedProxies } from "../src/config";

let directory: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agentdesk-gateway-config-"));
  const key = join(directory, "key");
  writeFileSync(key, randomBytes(32).toString("hex"));
  env = {
    PUBLIC_ORIGIN: "https://agent.example.test",
    OWNER_EMAIL: " Owner@Example.Test ",
    GATEWAY_DATA_DIR: directory,
    SESSION_SECRET_FILE: key,
    OTP_PEPPER_FILE: key,
    REMOTE_SHARED_TOKEN_FILE: key,
    CLOUD_RUNNER_URL: "http://runner:17893",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "owner",
    SMTP_PASSWORD_FILE: key,
    SMTP_FROM: "owner@example.test",
  };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("配置缺失、明文公开 URL、非法代理和错误密钥均拒绝启动", () => {
  expect(loadGatewayConfig(env).ownerEmail).toBe("owner@example.test");
  expect(loadGatewayConfig(env).authMultiUser).toBe(true);
  expect(loadGatewayConfig({ ...env, AUTH_MULTI_USER: "false" }).authMultiUser).toBe(false);
  expect(() => loadGatewayConfig({ ...env, AUTH_MULTI_USER: "yes" })).toThrow(/AUTH_MULTI_USER/);
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    expect(() => loadGatewayConfig(missing), key).toThrow();
  }
  for (const origin of [
    "http://agent.example.test",
    "https://user:pass@agent.example.test",
    "https://agent.example.test/path",
  ])
    expect(() => loadGatewayConfig({ ...env, PUBLIC_ORIGIN: origin })).toThrow();
  expect(() => parseTrustedProxies("0.0.0.0/0")).toThrow();
  expect(() => parseTrustedProxies("invalid/24")).toThrow();
  writeFileSync(env.SESSION_SECRET_FILE!, "short");
  expect(() => loadGatewayConfig(env)).toThrow(/secret/);
});

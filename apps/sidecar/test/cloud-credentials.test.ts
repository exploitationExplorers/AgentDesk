import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { AppError, httpStatusOf } from "@agentdesk/shared";
import { ZodError } from "zod";
import { openDatabase, type DbHandle } from "../src/db/client";
import { businessDatabase } from "../src/db/business-database";
import type { Container } from "../src/container";
import type { CloudConfig } from "../src/cloud-config";
import { remoteRoutes } from "../src/http/routes/remote";
import { SecretStore } from "../src/secrets";
import { ProviderService } from "../src/services/providers";

let handle: DbHandle;
afterEach(() => handle?.close());

function fixture(allow = false) {
  handle = openDatabase(":memory:");
  const secrets = new SecretStore(handle.db, Buffer.alloc(32, 7).toString("base64"), "/unused");
  const providers = new ProviderService(handle.db, secrets);
  const actor = {
    userId: "owner-1",
    sessionId: "session-1",
    recentAuthAt: new Date().toISOString(),
  };
  const container = {
    business: businessDatabase(handle.raw),
    dbHandle: handle,
    providers,
    cloudRunner: {},
    remoteGrants: {},
    remoteApprovals: {},
    shutdownSignal: new AbortController().signal,
    cloudConfig: {
      ownerUserId: actor.userId,
      remoteToken: "internal-test-token",
      allowedProviderHosts: ["api.openai.com"],
      allowServerProviderCredentials: allow,
    },
  } as unknown as Container & { cloudConfig: CloudConfig };
  const app = new Hono().route("/remote", remoteRoutes(container));
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toBody(), httpStatusOf(error.code) as 400);
    if (error instanceof ZodError) return c.json({ error: "invalid" }, 400);
    throw error;
  });
  const input = {
    name: "cloud service",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    models: ["synthetic-model"],
    defaultModel: "synthetic-model",
    source: "manual",
    enabled: true,
    apiKey: "synthetic-private-key",
  };
  const write = (value: unknown) =>
    app.request("/remote/host/providers/new", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentdesk-remote-token": "internal-test-token",
      },
      body: JSON.stringify({ actor, input: value }),
    });
  return { app, write, input, providers, secrets };
}

it("Runner 默认拒绝个人 Key，不能绕过 Gateway 直接落库", async () => {
  const f = fixture();
  expect((await f.write(f.input)).status).toBe(403);
  expect((await f.write({ ...f.input, credentialPurpose: "server-service" })).status).toBe(403);
  expect(f.providers.list()).toEqual([]);
  expect(handle.raw.prepare("SELECT count(*) AS n FROM secrets").get()).toMatchObject({ n: 0 });
});

it("部署者启用后仍须明确选择独立服务器凭证，返回值不回显 Key", async () => {
  const f = fixture(true);
  expect((await f.write(f.input)).status).toBe(400);
  const response = await f.write({ ...f.input, credentialPurpose: "server-service" });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("synthetic-private-key");
  expect(JSON.parse(body).hasKey).toBe(true);
  const list = await f.app.request("/remote/host/providers", {
    headers: { "x-agentdesk-remote-token": "internal-test-token" },
  });
  expect(await list.json()).toMatchObject({
    credentialPolicy: {
      allowServerCredentials: true,
      personalKeys: "local-only",
      storage: "server",
    },
  });
});

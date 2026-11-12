import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { StoragePolicy } from "@agentdesk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayApp } from "../src/app";
import { createGatewayAuth } from "../src/auth/service";
import { parseTrustedProxies, type GatewayConfig } from "../src/config";
import { GatewayStore } from "../src/db/store";
import { recoverOwner } from "../src/auth/recovery";
import { RunnerClient } from "../src/remote/client";
import { RemoteGatewayService } from "../src/remote/service";
import { RemoteRoutingStore } from "../src/remote/store";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../src/auth/session-policy";
let db: Database.Database;
let app: ReturnType<typeof createGatewayApp>;
let config: GatewayConfig;
let sent: string[];
let mailFailure: boolean;
let peer: string;
let loginHeaders: Record<string, string>;
let runnerResponder: (url: string, init?: RequestInit) => Response;
beforeEach(async () => {
  db = new Database(":memory:");
  config = {
    publicOrigin: "https://agent.example.test",
    ownerEmail: "owner@example.test",
    authMultiUser: false,
    dataDir: "/unused",
    host: "127.0.0.1",
    port: 3000,
    sessionSecret: randomBytes(32).toString("hex"),
    otpPepper: randomBytes(32).toString("hex"),
    remoteToken: randomBytes(32).toString("hex"),
    runnerUrl: "http://runner:17893",
    cloudHostName: "Cloud server",
    cloudWorkspaceRoot: "/workspaces",
    providerHostAllowlist: ["api.openai.com", "api.anthropic.com", "api.deepseek.com"],
    trustedProxies: parseTrustedProxies("127.0.0.1/32"),
    smtp: {
      host: "smtp.example.test",
      port: 465,
      secure: true,
      user: "owner",
      password: "test",
      from: "owner@example.test",
    },
  };
  sent = [];
  mailFailure = false;
  peer = "127.0.0.1";
  runnerResponder = () => Response.json({});
  const store = new GatewayStore(db, config.otpPepper);
  const auth = await createGatewayAuth(config, db, async (_email, otp) => {
    if (mailFailure) throw new Error("SMTP delivery failed with private credentials");
    sent.push(otp);
  });
  const routing = new RemoteRoutingStore(db);
  const runner = new RunnerClient(config, async (url, init) => runnerResponder(String(url), init));
  const remote = new RemoteGatewayService(runner, routing);
  app = createGatewayApp({ config, auth, store, runner, remote, routing, peerAddress: () => peer });
  const csrf = await app.request(`${config.publicOrigin}/api/v1/auth/csrf`, {
    headers: { host: "agent.example.test" },
  });
  loginHeaders = {
    cookie: csrf.headers.getSetCookie()[0]!.split(";")[0]!,
    "x-csrf-token": (await csrf.json()).csrfToken,
  };
});
afterEach(() => db.close());
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`${config.publicOrigin}/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: "agent.example.test",
      origin: config.publicOrigin,
      "content-type": "application/json",
      ...(path.startsWith("auth/otp/") ? loginHeaders : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const send = () => request("auth/otp/request", { email: config.ownerEmail });
const verify = (otp = sent.at(-1)) => request("auth/otp/verify", { email: config.ownerEmail, otp });
async function login() {
  expect((await send()).status).toBe(202);
  const response = await verify();
  expect(response.status).toBe(200);
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-agentdesk_session="))!;
  expect(setCookie).toBeTruthy();
  const cookie = setCookie.split(";")[0]!;
  return { cookie, setCookie, response };
}
it("云存储仅 owner 可访问，写操作验证 CSRF 且只转发服务端身份", async () => {
  const { cookie } = await login();
  const session = await (await request("session", undefined, { cookie })).json();
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    method: string;
  }> = [];
  runnerResponder = (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), method: init?.method ?? "GET" });
    return Response.json({ hostId: "cloud" });
  };
  expect((await request("hosts/cloud/storage")).status).toBe(401);
  expect((await request("hosts/cloud/storage", undefined, { cookie })).status).toBe(200);
  expect(calls[0]).toMatchObject({
    url: "http://runner:17893/remote-api/v1/host/storage/status",
    method: "POST",
    body: { actor: { userId: session.user.id, sessionId: session.session.id } },
  });
  expect((await request("hosts/office/storage", undefined, { cookie })).status).toBe(403);
  expect((await request("hosts/cloud/storage/cleanup/preview", {}, { cookie })).status).toBe(403);
  const headers = { cookie, "x-csrf-token": session.csrfToken };
  expect(
    (await request("hosts/cloud/storage/cleanup/preview", { actor: { userId: "forged" } }, headers))
      .status,
  ).toBe(400);
  const previewId = crypto.randomUUID();
  expect(
    (await request("hosts/cloud/storage/cleanup", { previewId, path: "/private" }, headers)).status,
  ).toBe(400);
  expect(calls).toHaveLength(1);
  expect((await request("hosts/cloud/storage/cleanup/preview", {}, headers)).status).toBe(200);
  expect((await request("hosts/cloud/storage/cleanup", { previewId }, headers)).status).toBe(200);
  const policy = StoragePolicy.parse({ automaticCleanup: true, eventDays: 45 });
  const response = await app.request(`${config.publicOrigin}/api/v1/hosts/cloud/storage/policy`, {
    method: "PUT",
    headers: {
      ...headers,
      host: "agent.example.test",
      origin: config.publicOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify(policy),
  });
  expect(response.status).toBe(200);
  expect(calls.at(-1)).toMatchObject({
    method: "PUT",
    body: { policy, actor: { userId: session.user.id, sessionId: session.session.id } },
  });
  expect(calls).toHaveLength(4);
});
it("云存储修改要求近期认证，过期会话只能读取容量", async () => {
  const { cookie } = await login();
  const session = await (await request("session", undefined, { cookie })).json();
  let calls = 0;
  runnerResponder = () => {
    calls++;
    return Response.json({});
  };
  db.prepare("UPDATE gateway_session_auth SET authenticated_at=?").run(
    new Date(Date.now() - 16 * 60000).toISOString(),
  );
  expect((await request("hosts/cloud/storage", undefined, { cookie })).status).toBe(200);
  expect(
    (
      await request(
        "hosts/cloud/storage/cleanup/preview",
        {},
        { cookie, "x-csrf-token": session.csrfToken },
      )
    ).status,
  ).toBe(401);
  expect(calls).toBe(1);
});
it("凭证输入仅在 Gateway 和 Runner 同时启用时开放", async () => {
  const { cookie } = await login();
  let runnerEnabled = true;
  runnerResponder = () =>
    Response.json({
      providers: [],
      bindings: [],
      credentialPolicy: { allowServerCredentials: runnerEnabled },
    });
  const read = async () =>
    (await (await request("hosts/cloud/providers", undefined, { cookie })).json()).credentialPolicy;
  expect(await read()).toMatchObject({ allowServerCredentials: false });
  config.allowServerProviderCredentials = true;
  expect(await read()).toMatchObject({ allowServerCredentials: true });
  runnerEnabled = false;
  expect(await read()).toMatchObject({ allowServerCredentials: false });
});
it("Gateway 默认拒绝上传个人 Key，启用后还要求服务器凭证用途，拒绝请求不转发", async () => {
  const { cookie } = await login();
  const session = await (await request("session", undefined, { cookie })).json();
  const forwarded: unknown[] = [];
  runnerResponder = (_url, init) => {
    forwarded.push(JSON.parse(String(init?.body)));
    return Response.json({ provider: { id: "cloud-model" } });
  };
  const input = {
    name: "service",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    models: ["model"],
    defaultModel: "model",
    source: "manual",
    enabled: true,
    apiKey: "synthetic-personal-key",
  };
  const write = (body: unknown) =>
    app.request(`${config.publicOrigin}/api/v1/hosts/cloud/providers/new`, {
      method: "PUT",
      headers: {
        host: "agent.example.test",
        origin: config.publicOrigin,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify(body),
    });
  expect((await write(input)).status).toBe(403);
  expect(forwarded).toEqual([]);
  config.allowServerProviderCredentials = true;
  expect((await write(input)).status).toBe(400);
  expect(forwarded).toEqual([]);
  expect((await write({ ...input, credentialPurpose: "server-service" })).status).toBe(200);
  expect(forwarded).toHaveLength(1);
});
describe("Gateway 身份与会话", () => {
  it("项目任务列表保留 projectId 筛选，未知宿主不能读取云端项目", async () => {
    const { cookie } = await login();
    const queried: string[] = [];
    runnerResponder = (url, init) => {
      if (url.endsWith("/host/projects"))
        return Response.json({
          hostId: "cloud",
          projects: [
            { id: "project-a", name: "A", workspaceId: "workspace-a" },
            { id: "project-b", name: "B", workspaceId: "workspace-b" },
          ],
        });
      if (url.endsWith("/commands")) {
        const { command } = JSON.parse(String(init?.body));
        queried.push(command.projectId);
        return Response.json({ tasks: [{ id: `task-${command.projectId}` }] });
      }
      return Response.json({});
    };
    const filtered = await request("hosts/cloud/tasks?projectId=project-b", undefined, { cookie });
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({ tasks: [{ id: "task-project-b" }] });
    expect(queried).toEqual(["project-b"]);
    expect((await request("hosts/unknown/projects", undefined, { cookie })).status).toBe(404);
    expect((await request("hosts/unknown/projects/project-a", undefined, { cookie })).status).toBe(
      404,
    );
  });
  it("登录请求也要求 CSRF，缺失或跨会话 token 不发送邮件", async () => {
    expect(
      (await request("auth/otp/request", { email: config.ownerEmail }, { cookie: "" })).status,
    ).toBe(403);
    expect(
      (
        await request(
          "auth/otp/request",
          { email: config.ownerEmail },
          { "x-csrf-token": "forged" },
        )
      ).status,
    ).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it("仅 owner 登录，统一邮箱提示，不公开库的注册或 token 接口", async () => {
    const unknown = await request("auth/otp/request", { email: "stranger@example.test" });
    const owner = await send();
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual(await owner.json());
    expect(sent).toHaveLength(1);
    expect(
      (await request("auth/otp/verify", { email: "stranger@example.test", otp: sent[0] })).status,
    ).toBe(401);
    expect(
      (await app.request(`${config.publicOrigin}/internal-auth/sign-up/email`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(db.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 1 });
  });
  it("验证码 HMAC 与会话摘要落库，安全 Cookie 登录且响应无 bearer", async () => {
    await send();
    const challenge = db.prepare("SELECT value FROM verification").get() as {
      value: string;
    };
    expect(challenge.value).toMatch(/^[a-f0-9]{64}:0$/);
    expect(challenge.value).not.toContain(sent[0]);
    const response = await verify();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agentdesk_session="))!;
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain("Domain=");
    const record = db.prepare('SELECT token FROM "session"').get() as {
      token: string;
    };
    expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    expect(decodeURIComponent(cookie)).not.toContain(record.token);
    const session = await request("session", undefined, { cookie: cookie.split(";")[0]! });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: config.ownerEmail, role: "owner" },
      csrfToken: expect.any(String),
      session: { recentAuthAt: expect.any(String) },
    });
    expect(session.headers.get("cache-control")).toBe("no-store");
  });
  it("并发重放同一 OTP 只能产生一个会话", async () => {
    await send();
    const responses = await Promise.all([verify(), verify(), verify()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    expect(db.prepare('SELECT count(*) AS n FROM "session"').get()).toEqual({ n: 1 });
  });
  it("五次错误后不可再用，过期验证码拒绝，新验证码废弃旧码", async () => {
    await send();
    const first = sent[0];
    const wrong = first === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).status).toBe(401);
    expect((await verify(first)).status).toBe(401);
    db.prepare("DELETE FROM gateway_limits").run();
    await send();
    db.prepare('UPDATE verification SET "expiresAt"=?').run(
      new Date(Date.now() - 1000).toISOString(),
    );
    expect((await verify()).status).toBe(401);
    db.prepare("DELETE FROM gateway_limits").run();
    await send();
    const old = sent.at(-1);
    db.prepare("DELETE FROM gateway_limits").run();
    await send();
    expect(db.prepare("SELECT count(*) AS n FROM verification").get()).toEqual({ n: 1 });
    if (old !== sent.at(-1)) expect((await verify(old)).status).toBe(401);
    expect((await verify()).status).toBe(200);
  });
  it("发送限流和投递失败不会留下有效 challenge 或泄漏凭据", async () => {
    mailFailure = true;
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private credentials");
    expect(db.prepare("SELECT count(*) AS n FROM verification").get()).toEqual({ n: 0 });
    expect((await send()).status).toBe(429);
  });
  it("CSRF、Origin、Host 和非 JSON 请求均无法绕过", async () => {
    const { cookie } = await login();
    const response = await request("session", undefined, { cookie });
    const { csrfToken } = await response.json();
    expect((await request("logout", {}, { cookie })).status).toBe(403);
    expect(
      (
        await request(
          "logout",
          {},
          { cookie, "x-csrf-token": csrfToken, origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "logout",
          {},
          { cookie, "x-csrf-token": csrfToken, "content-type": "text/plain" },
        )
      ).status,
    ).toBe(403);
    expect((await request("session", undefined, { cookie, host: "evil.test" })).status).toBe(403);
    expect((await request("logout", {}, { cookie, "x-csrf-token": csrfToken })).status).toBe(200);
    expect((await request("session", undefined, { cookie })).status).toBe(401);
  });
  it("远程写操作必须同时持有有效会话和该会话的 CSRF token", async () => {
    const { cookie } = await login();
    const input = {
      clientRequestId: "request-remote-1",
      goal: "test task",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: "project-1",
    };
    expect((await request("hosts/cloud/projects/project-1/tasks", input, { cookie })).status).toBe(
      403,
    );
    const session = await request("session", undefined, { cookie });
    const { csrfToken } = await session.json();
    expect(
      (
        await request("hosts/cloud/projects/project-1/tasks", input, {
          cookie,
          "x-csrf-token": csrfToken,
        })
      ).status,
    ).toBe(503);
  });
  it("只信任实际连接来源，拒绝任意转发链和明文非代理请求", async () => {
    peer = "192.0.2.5";
    expect((await request("session", undefined, { "x-forwarded-for": "127.0.0.1" })).status).toBe(
      403,
    );
    peer = "127.0.0.1";
    expect(
      (await request("session", undefined, { "x-forwarded-for": "1.2.3.4, 127.0.0.1" })).status,
    ).toBe(400);
    expect(
      (
        await app.request("http://agent.example.test/api/v1/session", {
          headers: { host: "agent.example.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("http://agent.example.test/api/v1/session", {
          headers: {
            host: "agent.example.test",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "192.0.2.10",
          },
        })
      ).status,
    ).toBe(401);
  });
  it("全部退出立即撤销其他设备会话，空闲与绝对期限均生效", async () => {
    const first = await login();
    db.prepare("DELETE FROM gateway_limits").run();
    const second = await login();
    const { csrfToken } = await (
      await request("session", undefined, { cookie: first.cookie })
    ).json();
    expect(
      (
        await request(
          "sessions/revoke-all",
          {},
          { cookie: first.cookie, "x-csrf-token": csrfToken },
        )
      ).status,
    ).toBe(200);
    expect((await request("session", undefined, { cookie: second.cookie })).status).toBe(401);
    db.prepare("DELETE FROM gateway_limits").run();
    const idle = await login();
    db.prepare('UPDATE "session" SET "updatedAt"=?').run(
      new Date(Date.now() - SESSION_IDLE_MS - 1000).toISOString(),
    );
    expect((await request("session", undefined, { cookie: idle.cookie })).status).toBe(401);
    db.prepare("DELETE FROM gateway_limits").run();
    const expired = await login();
    db.prepare('UPDATE "session" SET "createdAt"=?').run(
      new Date(Date.now() - SESSION_ABSOLUTE_MS - 1000).toISOString(),
    );
    expect((await request("session", undefined, { cookie: expired.cookie })).status).toBe(401);
  });
  it("重新创建服务仍能验证已有会话，数据库摘要不能代替真实 Cookie", async () => {
    const { cookie } = await login();
    const store = new GatewayStore(db, config.otpPepper);
    const auth = await createGatewayAuth(config, db, async () => undefined);
    const routing = new RemoteRoutingStore(db);
    const runner = new RunnerClient(config, async () => new Response("{}"));
    const remote = new RemoteGatewayService(runner, routing);
    app = createGatewayApp({
      config,
      store,
      auth,
      runner,
      remote,
      routing,
      peerAddress: () => peer,
    });
    expect((await request("session", undefined, { cookie })).status).toBe(200);
    const { token } = db.prepare('SELECT token FROM "session"').get() as {
      token: string;
    };
    const context = await auth.$context;
    expect(await context.internalAdapter.findSession(token)).toBeNull();
    expect(
      (await request("session", undefined, { cookie: `__Host-agentdesk_session=${token}` })).status,
    ).toBe(401);
  });
  it("服务器恢复保留 userId，撤销会话和验证码，并拒绝配置静默换 owner", async () => {
    const { cookie } = await login();
    const owner = db.prepare('SELECT id FROM "user"').get() as {
      id: string;
    };
    await expect(
      createGatewayAuth({ ...config, ownerEmail: "new@example.test" }, db, async () => undefined),
    ).rejects.toThrow(/recovery/);
    db.prepare("DELETE FROM gateway_limits").run();
    await send();
    expect(await recoverOwner(db, " New@Example.Test ")).toBe(owner.id);
    expect(db.prepare('SELECT id,email FROM "user"').get()).toEqual({
      id: owner.id,
      email: "new@example.test",
    });
    expect(db.prepare('SELECT count(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM verification").get()).toEqual({ n: 0 });
    expect((await request("session", undefined, { cookie })).status).toBe(401);
    await expect(
      createGatewayAuth({ ...config, ownerEmail: "new@example.test" }, db, async () => undefined),
    ).resolves.toBeTruthy();
  });
  it("多用户模式下任意邮箱可注册登录，owner 仍保留 role", async () => {
    config = { ...config, authMultiUser: true };
    const store = new GatewayStore(db, config.otpPepper);
    const auth = await createGatewayAuth(config, db, async (_email, otp) => {
      sent.push(otp);
    });
    const routing = new RemoteRoutingStore(db);
    const runner = new RunnerClient(config, async () => Response.json({}));
    const remote = new RemoteGatewayService(runner, routing);
    app = createGatewayApp({
      config,
      auth,
      store,
      runner,
      remote,
      routing,
      peerAddress: () => peer,
    });
    const csrf = await app.request(`${config.publicOrigin}/api/v1/auth/csrf`, {
      headers: { host: "agent.example.test" },
    });
    loginHeaders = {
      cookie: csrf.headers.getSetCookie()[0]!.split(";")[0]!,
      "x-csrf-token": (await csrf.json()).csrfToken,
    };
    expect((await request("auth/otp/request", { email: "member@example.test" })).status).toBe(202);
    expect(sent).toHaveLength(1);
    const memberLogin = await request("auth/otp/verify", {
      email: "member@example.test",
      otp: sent[0],
    });
    expect(memberLogin.status).toBe(200);
    const memberCookie = memberLogin.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agentdesk_session="))!
      .split(";")[0]!;
    const memberSession = await request("session", undefined, { cookie: memberCookie });
    const memberData = await memberSession.json();
    expect(memberData).toMatchObject({
      user: { email: "member@example.test", role: "member" },
    });
    expect((await request("hosts/cloud/storage", undefined, { cookie: memberCookie })).status).toBe(
      403,
    );
    expect(
      (
        await request(
          "hosts/cloud/storage/cleanup/preview",
          {},
          { cookie: memberCookie, "x-csrf-token": memberData.csrfToken },
        )
      ).status,
    ).toBe(403);
    db.prepare("DELETE FROM gateway_limits").run();
    const owner = await login();
    const ownerSession = await request("session", undefined, { cookie: owner.cookie });
    expect(await ownerSession.json()).toMatchObject({
      user: { email: config.ownerEmail, role: "owner" },
    });
    expect(db.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 2 });
  });
});

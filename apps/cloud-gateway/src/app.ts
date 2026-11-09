import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { AppError, ErrorCode, OwnerEmail, httpStatusOf } from "@agentdesk/shared";
import { z } from "zod";
import type { GatewayConfig } from "./config";
import type { GatewayAuth } from "./auth/service";
import { authHeaders, clientAddress, csrfToken, requireSession, verifyCsrf } from "./auth/access";
import type { GatewayStore } from "./db/store";
import type { RunnerClient } from "./remote/client";
import type { RemoteGatewayService } from "./remote/service";
import type { RemoteRoutingStore } from "./remote/store";
import { registerCloudAssets } from "./static";
import type { DeviceRelay } from "./devices/relay";
import { registerDeviceRoutes } from "./devices/routes";
import { GatewayTransfers } from "./remote/transfers";
import { GatewayEvents } from "./remote/events";
import {
  ProviderInput,
  AgentModelBinding,
  RemoteApprovalDecision,
  RemoteId,
  RemoteTaskInput,
} from "@agentdesk/shared";

const EmailInput = z.strictObject({ email: OwnerEmail });
const VerifyInput = EmailInput.extend({ otp: z.string().regex(/^\d{6}$/) });

export function createGatewayApp(deps: {
  config: GatewayConfig;
  auth: GatewayAuth;
  store: GatewayStore;
  runner: RunnerClient;
  remote: RemoteGatewayService;
  routing: RemoteRoutingStore;
  staticDir?: string;
  devices?: DeviceRelay;
  transfers?: GatewayTransfers;
  shutdownSignal?: AbortSignal;
  peerAddress: (context: Context) => string;
}) {
  const { config, auth, store } = deps;
  const events = new GatewayEvents(deps.runner, deps.routing);
  deps.shutdownSignal?.addEventListener("abort", () => events.closeAll(), { once: true });
  const app = new Hono<{ Variables: { clientIp: string } }>();
  // 一个身份库一个写进程；串行 OTP 发行／验证也防止旧请求覆盖刚轮换的新 challenge。
  let authTail: Promise<unknown> = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = authTail.then(action);
    authTail = result.catch(() => undefined);
    return result;
  }
  app.use("*", async (c, next) => {
    if (deps.shutdownSignal?.aborted)
      return c.json(new AppError(ErrorCode.ServiceUnavailable, "服务正在关闭").toBody(), 503);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    await next();
  });
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) => c.json(new AppError(ErrorCode.BadRequest, "请求过大").toBody(), 413),
    }),
  );
  app.use("/api/*", async (c, next) => {
    c.set("clientIp", clientAddress(c, config, deps.peerAddress(c)));
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (
        c.req.header("origin") !== config.publicOrigin ||
        c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      )
        throw new AppError(ErrorCode.Forbidden, "请求来源或类型无效");
    }
    await next();
  });
  app.get("/api/v1/auth/csrf", (c) => {
    const nonce = `${Date.now()}.${randomBytes(32).toString("hex")}`;
    setCookie(c, "__Host-agentdesk_login", nonce, {
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 600,
    });
    return c.json({ csrfToken: csrfToken(`login:${nonce}`, config.sessionSecret) });
  });
  app.use("/api/v1/auth/otp/*", async (c, next) => {
    const nonce = getCookie(c, "__Host-agentdesk_login") ?? "";
    if (!/^\d{13}\.[a-f0-9]{64}$/.test(nonce))
      throw new AppError(ErrorCode.Forbidden, "请刷新登录页");
    const age = Date.now() - Number(nonce.split(".")[0]);
    if (age < 0 || age >= 600_000) throw new AppError(ErrorCode.Forbidden, "登录页已过期，请刷新");
    verifyCsrf(c.req.header("x-csrf-token"), `login:${nonce}`, config.sessionSecret);
    await next();
  });
  app.post("/api/v1/auth/otp/request", async (c) => {
    const { email } = EmailInput.parse(await c.req.json());
    store.limit([
      { key: `send-email:${email}`, max: 1, windowMs: 60_000 },
      { key: `send-ip:${c.get("clientIp")}`, max: 10, windowMs: 600_000 },
      { key: "send-total", max: 100, windowMs: 600_000 },
    ]);
    await serialize(async () => {
      if (email !== config.ownerEmail) return;
      const context = await auth.$context;
      // 库的 rotate 默认依赖 identifier 唯一性；显式废弃旧 challenge 后再发行。
      await context.internalAdapter.deleteVerificationByIdentifier(`sign-in-otp-${email}`);
      try {
        // 库的发送接口会吞掉 SMTP 异常；使用其 server-only 发行接口，再显式等待投递。
        const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
        await auth.deliverOtp(email, otp);
      } catch {
        await context.internalAdapter.deleteVerificationByIdentifier(`sign-in-otp-${email}`);
        store.audit("auth.otp.request", "delivery_failed");
        throw new AppError(ErrorCode.ServiceUnavailable, "邮件暂时无法发送，请稍后重试");
      }
    });
    return c.json({ message: "如果该邮箱允许登录，你将收到验证码。" }, 202);
  });
  app.post("/api/v1/auth/otp/verify", async (c) => {
    const { email, otp } = VerifyInput.parse(await c.req.json());
    store.limit([
      { key: `verify-ip:${c.get("clientIp")}`, max: 30, windowMs: 300_000 },
      { key: `verify-email:${email}`, max: 20, windowMs: 300_000 },
    ]);
    return serialize(async () => {
      if (email !== config.ownerEmail)
        throw new AppError(ErrorCode.Unauthorized, "验证码无效或已过期");
      const previous = await auth.api.getSession({
        headers: authHeaders(c, config),
        query: { disableRefresh: true },
      });
      const response = await auth.api.signInEmailOTP({
        body: { email, otp },
        headers: authHeaders(c, config),
        asResponse: true,
      });
      if (!response.ok) {
        store.audit("auth.otp.verify", "rejected");
        throw new AppError(ErrorCode.Unauthorized, "验证码无效或已过期");
      }
      if (previous) store.removeSession(previous.session.id);
      for (const cookie of response.headers.getSetCookie())
        c.header("Set-Cookie", cookie, { append: true });
      const sessionCookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const sessionResult = await auth.api.getSession({
        headers: new Headers({ origin: config.publicOrigin, cookie: sessionCookie }),
      });
      if (sessionResult)
        store.markSessionAuthenticated(sessionResult.user.id, sessionResult.session.id);
      store.audit("auth.otp.verify", "authenticated");
      // 不转发库返回的 bearer token，只通过 HttpOnly Cookie 交付。
      return c.json({ authenticated: true });
    });
  });
  app.get("/api/v1/session", async (c) => {
    const { session, user } = await requireSession(auth, store, authHeaders(c, config), config);
    const recentAuthAt = store.sessionAuthenticatedAt(user.id, session.id);
    return c.json({
      user: { id: user.id, email: user.email, role: "owner" },
      session: { id: session.id, expiresAt: session.expiresAt, recentAuthAt },
      csrfToken: csrfToken(session.id, config.sessionSecret),
    });
  });
  const loggedIn = async (c: Context) => {
    const result = await requireSession(auth, store, authHeaders(c, config), config);
    if (!["GET", "HEAD"].includes(c.req.method))
      verifyCsrf(c.req.header("x-csrf-token"), result.session.id, config.sessionSecret);
    return {
      actor: {
        userId: result.user.id,
        sessionId: result.session.id,
        recentAuthAt:
          store.sessionAuthenticatedAt(result.user.id, result.session.id) ??
          new Date(0).toISOString(),
      },
      result,
    };
  };
  if (deps.devices) registerDeviceRoutes(app, { ...deps, relay: deps.devices, loggedIn });
  const transfers = deps.transfers ?? new GatewayTransfers(store.db, deps.remote, deps.routing);
  app.get("/api/v1/transfers", async (c) =>
    c.json({ transfers: transfers.list((await loggedIn(c)).actor) }),
  );
  app.post("/api/v1/transfers", async (c) =>
    c.json(await transfers.create((await loggedIn(c)).actor, await c.req.json()), 202),
  );
  app.get("/api/v1/transfers/:id", async (c) =>
    c.json(await transfers.get((await loggedIn(c)).actor, c.req.param("id"))),
  );
  app.post("/api/v1/transfers/:id/resume", async (c) =>
    c.json(await transfers.resume((await loggedIn(c)).actor, c.req.param("id")), 202),
  );
  app.post("/api/v1/transfers/:id/import", async (c) => {
    const { actor } = await loggedIn(c);
    const body = z
      .strictObject({ manifestDigest: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await c.req.json());
    return c.json(await transfers.import(actor, c.req.param("id"), body.manifestDigest));
  });
  const projectRoute = /^\/api\/v1\/hosts\/([^/]+)\/projects\/([^/]+)(?:\/(.*))?$/;
  const taskRoute = /^\/api\/v1\/hosts\/([^/]+)\/tasks(?:\/([^/]+))?(?:\/(.*))?$/;
  const approvalRoute = /^\/api\/v1\/hosts\/([^/]+)\/approvals\/([^/]+)\/resolve$/;
  const hostRoute = /^\/api\/v1\/hosts\/([^/]+)(?:\/(.*))?$/;
  const providerRoute = /^\/api\/v1\/hosts\/([^/]+)\/providers(?:\/([^/]+))?(?:\/(.*))?$/;
  const providerAllowed = new Set(config.providerHostAllowlist);

  app.all("/api/v1/hosts", async (c) => {
    if (c.req.method !== "GET") throw new AppError(ErrorCode.NotFound, "接口不存在");
    const { actor } = await loggedIn(c);
    const cloud = await deps.runner
      .json<{
        hostId: string;
        mode: string;
        capabilities: string[];
        executors?: Array<{ id: string; available: boolean; reason?: string }>;
      }>("/health")
      .catch((error: unknown) => {
        if (error instanceof AppError && error.code === ErrorCode.HostOffline) return null;
        throw error;
      });
    if (cloud && (cloud.hostId !== "cloud" || cloud.mode !== "cloud"))
      throw new AppError(ErrorCode.ServiceUnavailable, "云端宿主身份不匹配");
    const projects = cloud ? await deps.remote.projects(actor) : [];
    return c.json({
      hosts: [
        ...(deps.devices?.store
          .list(actor.userId)
          .filter((d) => d.state === "active")
          .map((d) => ({
            id: d.id,
            name: d.identity.name,
            kind: "office",
            status: deps.devices!.online(d.id) ? "online" : "offline",
            lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
            projects: d.projects.length,
            capabilities: [],
            executors: [
              { id: "native-bot", available: true },
              { id: "codex", available: false, reason: "尚未配置 Codex 执行器" },
            ],
          })) ?? []),
        {
          id: "cloud",
          name: config.cloudHostName,
          kind: "cloud",
          status: cloud ? "online" : "offline",
          lastSeen: cloud ? new Date().toISOString() : null,
          capabilities: cloud?.capabilities ?? [],
          executors: cloud?.executors ?? [],
          projects: projects.length,
        },
      ],
    });
  });
  app.all("/api/v1/hosts/*", async (c) => {
    const { actor } = await loggedIn(c);
    const path = new URL(c.req.url).pathname;
    const hostMatch = path.match(hostRoute);
    const projectMatch = path.match(projectRoute);
    const taskMatch = path.match(taskRoute);
    const approvalMatch = path.match(approvalRoute);
    const providerMatch = path.match(providerRoute);
    if (!hostMatch) throw new AppError(ErrorCode.NotFound, "?????");
    if (hostMatch[1] !== "cloud") deps.devices?.store.get(hostMatch[1]!, actor.userId);
    const runner = deps.runner.forHost(hostMatch[1]!);
    if (hostMatch[1] !== "cloud" && hostMatch[2] === undefined && c.req.method === "GET") {
      const d = deps.devices!.store.get(hostMatch[1]!, actor.userId);
      return c.json({
        id: d.id,
        name: d.identity.name,
        kind: "office",
        status: deps.devices!.online(d.id) ? "online" : "offline",
        lastSeen: d.lastSeen,
        projects: d.projects.length,
      });
    }
    if (hostMatch && hostMatch[2] === "executors" && c.req.method === "GET") {
      const host = await runner.json<{
        executors: Array<{ id: string; available: boolean; reason?: string }>;
      }>("/host");
      return c.json({ executors: host.executors });
    }
    if (
      hostMatch &&
      /^(repository-imports(?:\/[A-Za-z0-9_-]+)?|repository-fetch|git-credentials(?:\/test)?)$/.test(
        hostMatch[2] ?? "",
      )
    ) {
      if (hostMatch[1] !== "cloud") throw new AppError(ErrorCode.Forbidden, "请在云端宿主添加仓库");
      if (c.req.method === "GET" && hostMatch[2]!.startsWith("repository-imports"))
        return c.json(await runner.json(`/host/${hostMatch[2]}`));
      if (c.req.method !== "POST") throw new AppError(ErrorCode.NotFound, "接口不存在");
      if (Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
        throw new AppError(ErrorCode.Unauthorized, "配置 Git 需要重新验证邮箱");
      const input = await c.req.json();
      if (hostMatch[2] === "repository-fetch")
        return c.json(
          await runner.json("/host/repository-fetch", {
            actor,
            projectId: input.projectId,
            ref: input.ref,
          }),
        );
      return c.json(
        await runner.json(
          `/host/${hostMatch[2]}`,
          hostMatch[2] === "git-credentials/test" ? { actor, url: input.url } : { actor, input },
        ),
        hostMatch[2] === "repository-imports" ? 202 : 200,
      );
    }
    if (
      hostMatch &&
      /^executors\/codex\/(login|login-status)$/.test(hostMatch[2] ?? "") &&
      c.req.method === "POST"
    ) {
      if (Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
        throw new AppError(ErrorCode.Unauthorized, "Codex 登录需要重新验证邮箱");
      return c.json(await runner.json(`/host/${hostMatch[2]}`, { actor }));
    }
    if (hostMatch && hostMatch[2] === "provider-bindings" && c.req.method === "PUT") {
      if (Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
        throw new AppError(ErrorCode.Unauthorized, "修改模型绑定需要重新验证邮箱");
      const { bindings } = z
        .strictObject({ bindings: z.array(AgentModelBinding).max(6) })
        .parse(await c.req.json());
      return c.json(await runner.json("/host/provider-bindings", { actor, bindings }, "PUT"));
    }
    if (
      hostMatch &&
      /^operations\/[A-Za-z0-9_.:-]+$/.test(hostMatch[2] ?? "") &&
      c.req.method === "GET"
    )
      return c.json(
        await deps.remote.operation(
          actor,
          hostMatch[1]!,
          hostMatch[2]!.slice("operations/".length),
        ),
      );
    if (hostMatch && hostMatch[2] === "projects" && c.req.method === "GET")
      return c.json({ projects: await deps.remote.projects(actor, hostMatch[1]!) });
    if (hostMatch && hostMatch[2] === undefined && c.req.method === "GET") {
      const cloud = await runner.json<{
        hostId: string;
        mode: string;
        capabilities: string[];
        executors?: Array<{ id: string; available: boolean; reason?: string }>;
      }>("/health");
      if (hostMatch[1] !== "cloud" || cloud.hostId !== "cloud")
        throw new AppError(ErrorCode.NotFound, "执行宿主不存在");
      return c.json({
        id: "cloud",
        name: config.cloudHostName,
        kind: "cloud",
        status: "online",
        capabilities: cloud.capabilities,
        executors: cloud.executors,
      });
    }
    if (projectMatch) {
      const [, hostId, projectId, tail = ""] = projectMatch;
      if (!tail && c.req.method === "GET") {
        const projects = await deps.remote.projects(actor, hostMatch[1]!);
        const p = projects.find((item) => item.id === projectId);
        if (!p) throw new AppError(ErrorCode.NotFound, "项目不存在");
        return c.json(p);
      }
      if (tail === "status" && c.req.method === "GET") {
        const scope = await deps.remote.scope(actor, hostId!, projectId!);
        const status = await runner.execute<Record<string, unknown>>(scope, actor, "project.read", {
          kind: "status",
        });
        return c.json(status);
      }
      if (tail === "git/status" && c.req.method === "GET") {
        const scope = await deps.remote.scope(actor, hostId!, projectId!);
        const payload = { kind: "git-status", clientRequestId: randomUUID() };
        return c.json(
          await runner.execute(scope, actor, "project.read", payload, payload.clientRequestId),
        );
      }
      if (tail === "snapshots" && c.req.method === "POST") {
        const scope = await deps.remote.scope(actor, hostId!, projectId!);
        const body = z
          .strictObject({ clientRequestId: RemoteId, files: z.array(z.string()).min(1).max(2000) })
          .parse(await c.req.json());
        return c.json(
          await runner.execute(scope, actor, "snapshot.create", body, body.clientRequestId),
          201,
        );
      }
      if (tail === "tasks" && c.req.method === "POST") {
        const input = RemoteTaskInput.parse(await c.req.json());
        return c.json(await deps.remote.submit(actor, hostId!, projectId!, input), 202);
      }
      if (tail === "git/preview" && c.req.method === "POST") {
        const scope = await deps.remote.scope(actor, hostId!, projectId!);
        const body = await c.req.json<{
          clientRequestId?: string;
          kind: string;
          files?: string[];
          message?: string;
          remote?: string;
          ref?: string;
        }>();
        if (body.kind !== "commit" && body.kind !== "push")
          throw new AppError(ErrorCode.BadRequest, "无效的 Git 操作类型");
        if (body.kind === "push" && Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
          throw new AppError(ErrorCode.Unauthorized, "推送前需要重新验证邮箱");
        const clientRequestId = RemoteId.parse(
          body.clientRequestId ?? c.req.header("x-request-id") ?? randomUUID(),
        );
        const result = await runner.execute(
          scope,
          actor,
          "git.preview",
          { ...body, clientRequestId },
          clientRequestId,
        );
        return c.json(result, 201);
      }
      if (tail === "git/commit" && c.req.method === "POST")
        return c.json(await thisExecuteGit("git.commit"));
      if (tail === "git/push" && c.req.method === "POST")
        return c.json(await thisExecuteGit("git.push"));
      throw new AppError(ErrorCode.NotFound, "接口不存在");
      async function thisExecuteGit(action: "git.commit" | "git.push") {
        const scope = await deps.remote.scope(actor, hostId!, projectId!);
        const body = await c.req.json<{ clientRequestId: string }>();
        const clientRequestId = RemoteId.parse(body.clientRequestId);
        if (action === "git.push" && Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
          throw new AppError(ErrorCode.Unauthorized, "推送前需要重新验证邮箱");
        return runner.execute(scope, actor, action, body, clientRequestId);
      }
    }
    if (taskMatch) {
      const [, hostId, id, tail = ""] = taskMatch;
      if (!id && c.req.method === "GET")
        return c.json({
          tasks: await deps.remote.tasks(
            actor,
            hostId!,
            new URL(c.req.url).searchParams.get("projectId") ?? undefined,
          ),
        });
      if (!id) throw new AppError(ErrorCode.BadRequest, "缺少任务标识");
      const scope = await deps.remote.taskScope(actor, hostId!, id!);
      if (!tail && c.req.method === "GET") {
        const result = await runner.execute<Record<string, unknown>>(scope, actor, "task.read", {
          taskId: id,
        });
        const runs = result.runs as Array<{ id: string }> | undefined;
        const task = result.task as { currentRunId?: string };
        return c.json({
          ...result,
          run: runs?.find((run) => run.id === task.currentRunId) ?? runs?.at(-1),
        });
      }
      if (tail === "cancel" && c.req.method === "POST") {
        const body = await c.req.json<{ clientRequestId?: string }>();
        const payload = {
          taskId: id,
          clientRequestId: body.clientRequestId ?? c.req.header("x-request-id") ?? randomUUID(),
        };
        return c.json(
          await runner.execute(scope, actor, "task.cancel", payload, payload.clientRequestId),
          202,
        );
      }
      if (tail === "followup" && c.req.method === "POST") {
        const body = await c.req.json<{ message?: string; clientRequestId?: string }>();
        if (!body.message?.trim()) throw new AppError(ErrorCode.BadRequest, "请输入继续说明");
        const payload = {
          taskId: id,
          message: body.message,
          clientRequestId: body.clientRequestId ?? c.req.header("x-request-id") ?? randomUUID(),
        };
        const result = await deps.remote.followup(
          actor,
          scope,
          id,
          payload.message,
          payload.clientRequestId,
        );
        return c.json(result, 202);
      }
      if (tail === "events" && c.req.method === "GET") {
        const after =
          c.req.header("last-event-id") ?? new URL(c.req.url).searchParams.get("after") ?? "0";
        if (!/^\d{1,16}$/.test(after)) throw new AppError(ErrorCode.BadRequest, "无效的事件游标");
        const body = await events.open(actor, scope, id, Number(after), c.req.raw.signal);
        c.header("Content-Type", "text/event-stream; charset=utf-8");
        c.header("Cache-Control", "no-store");
        c.header("X-Accel-Buffering", "no");
        return new Response(body, { status: 200, headers: c.res.headers });
      }
      throw new AppError(ErrorCode.NotFound, "接口不存在");
    }
    if (approvalMatch && c.req.method === "POST") {
      const [, hostId, id] = approvalMatch;
      const scope = await deps.remote.approvalScope(actor, hostId!, id!);
      const decision = RemoteApprovalDecision.parse(await c.req.json());
      return c.json(
        await runner.execute(
          scope,
          actor,
          "approval.resolve",
          { approvalId: id, ...decision },
          decision.clientRequestId,
        ),
      );
    }
    if (providerMatch) {
      const [, hostId, id, tail = ""] = providerMatch;
      deps.remote.requireCloud(hostId!);
      if (!id && c.req.method === "GET") return c.json(await runner.json("/host/providers"));
      if (tail === "test" && id && c.req.method === "POST") {
        const providerId = RemoteId.parse(id);
        const p = await runner.json<{ providers: Array<{ id: string }> }>("/host/providers");
        if (!p.providers.some((value) => value.id === providerId))
          throw new AppError(ErrorCode.NotFound, "Provider 不存在");
        if (Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
          throw new AppError(ErrorCode.Unauthorized, "测试模型配置需要重新登录");
        return c.json(
          await runner.json(`/host/providers/${providerId}/test`, { actor }, "POST"),
          202,
        );
      }
      if (id && c.req.method === "PUT") {
        if (Date.now() - Date.parse(actor.recentAuthAt) > 15 * 60_000)
          throw new AppError(ErrorCode.Unauthorized, "修改模型配置需要重新登录");
        RemoteId.parse(id);
        const input = ProviderInput.parse(await c.req.json());
        const endpoint = new URL(input.baseUrl);
        if (
          endpoint.protocol !== "https:" ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          !providerAllowed.has(endpoint.hostname.toLowerCase())
        )
          throw new AppError(
            ErrorCode.Forbidden,
            "模型地址必须使用 HTTPS，且主机名需精确列入服务器白名单",
          );
        return c.json(await runner.json(`/host/providers/${id}`, { actor, input }, "PUT"));
      }
      throw new AppError(ErrorCode.NotFound, "接口不存在");
    }
    throw new AppError(ErrorCode.NotFound, "接口不存在");
  });
  app.get("/api/v1/approvals", async (c) => {
    const { actor } = await loggedIn(c);
    const approvals = await deps.remote.approvals(actor);
    for (const d of deps.devices?.store.list(actor.userId) ?? []) {
      if (d.state === "active" && deps.devices!.online(d.id))
        approvals.push(...(await deps.remote.approvals(actor, d.id)));
    }
    return c.json({ approvals });
  });
  for (const path of ["logout", "sessions/revoke-all"]) {
    app.post(`/api/v1/${path}`, async (c) => {
      const { session, user } = await requireSession(auth, store, authHeaders(c, config), config);
      verifyCsrf(c.req.header("x-csrf-token"), session.id, config.sessionSecret);
      if (path === "sessions/revoke-all") store.revokeAll(user.id);
      else {
        store.removeSession(session.id);
        store.audit("session.logout", "revoked", user.id);
      }
      events.closeSession(session.id);
      void deps.remote.renew();
      c.header(
        "Set-Cookie",
        "__Host-agentdesk_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      );
      return c.json({ success: true });
    });
  }
  if (deps.staticDir) registerCloudAssets(app, deps.staticDir);
  app.notFound((c) => c.json(new AppError(ErrorCode.NotFound, "接口不存在").toBody(), 404));
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toBody(), httpStatusOf(error.code) as 400);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(new AppError(ErrorCode.BadRequest, "参数校验失败").toBody(), 400);
    // 身份库与 SMTP 错误可能包含敏感内容，不打印原始错误对象。
    console.error("[gateway] request failed");
    return c.json(new AppError(ErrorCode.Internal, "请求暂时无法完成").toBody(), 500);
  });
  return app;
}

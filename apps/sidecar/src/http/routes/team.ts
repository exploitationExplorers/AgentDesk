import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { AppError, ErrorCode } from "@agentdesk/shared";
import type { TeamService, TeamActor } from "../../services/team";

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
export function teamRoutes(
  service: TeamService,
  options: { adminKey?: string; allowedOrigins?: string[] } = {},
) {
  const app = new Hono<{ Variables: { actor: TeamActor } }>();
  let attempts = 0,
    windowStart = Date.now();
  app.use(
    "*",
    cors({
      origin: (origin) => (options.allowedOrigins?.includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: { message: "请求过大" } }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin && !options.allowedOrigins?.includes(origin))
      throw new AppError(ErrorCode.Forbidden, "来源未获授权");
    if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json"))
      throw new AppError(ErrorCode.BadRequest, "需要 JSON 请求");
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      attempts = 0;
    }
    const path = c.req.path.split("/").at(-1);
    if (["join", "pair", "create"].includes(path ?? "")) {
      if (++attempts > 120) return c.json({ error: { message: "尝试过于频繁，请稍后再试" } }, 429);
      return next();
    }
    const authorization = c.req.header("authorization") ?? "";
    if (!authorization.startsWith("Bearer "))
      throw new AppError(ErrorCode.Unauthorized, "请先加入项目");
    c.set("actor", await service.authenticate(authorization.slice(7)));
    return next();
  });
  app.post("/create", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    if (!options.adminKey || !safeEqual(auth, `Bearer ${options.adminKey}`))
      throw new AppError(ErrorCode.Unauthorized, "需要团队服务管理员授权");
    return c.json(await service.create(await c.req.json()), 201);
  });
  app.post("/join", async (c) => c.json(await service.join(await c.req.json()), 201));
  app.post("/pair", async (c) => c.json(await service.pair(await c.req.json()), 201));
  app.get("/room", async (c) => c.json(await service.detail(c.get("actor"))));
  app.post("/invites", async (c) => c.json(await service.invite(c.get("actor")), 201));
  app.post("/invites/revoke", async (c) => c.json(await service.revokeInvites(c.get("actor"))));
  app.post("/pairing-code", async (c) => c.json(await service.pairCode(c.get("actor")), 201));
  app.post("/members/:id/revoke", async (c) => {
    const input = z
      .strictObject({ connectionOnly: z.boolean().default(false) })
      .parse(await c.req.json());
    return c.json(await service.revoke(c.get("actor"), c.req.param("id"), input.connectionOnly));
  });
  app.post("/messages", async (c) =>
    c.json(await service.message(c.get("actor"), await c.req.json()), 201),
  );
  app.post("/tasks", async (c) =>
    c.json(await service.createTask(c.get("actor"), await c.req.json()), 201),
  );
  app.post("/claim", async (c) => c.json(await service.claim(c.get("actor"))));
  app.post("/tasks/:id/progress", async (c) =>
    c.json(await service.progress(c.get("actor"), c.req.param("id"), await c.req.json())),
  );
  app.post("/tasks/:id/block", async (c) =>
    c.json(await service.block(c.get("actor"), c.req.param("id"), await c.req.json())),
  );
  app.post("/tasks/:id/submit", async (c) =>
    c.json(await service.submit(c.get("actor"), c.req.param("id"), await c.req.json())),
  );
  app.post("/tasks/:id/review", async (c) =>
    c.json(await service.review(c.get("actor"), c.req.param("id"), await c.req.json())),
  );
  return app;
}

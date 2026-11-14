import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { AppError, ErrorCode, httpStatusOf } from "@agentdesk/shared";
import type { TeamService } from "./services/team";
import { teamRoutes } from "./http/routes/team";

/** 独立公网入口不挂载 sidecar 的 Provider、文件、Shell 或本机审批接口。 */
export function createTeamApp(
  service: TeamService,
  options: { adminKey: string; webRoot?: string; publicOrigin?: string },
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toBody(), httpStatusOf(error.code) as 400);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json(new AppError(ErrorCode.BadRequest, "参数校验失败").toBody(), 400);
    console.error("[team] request failed");
    return c.json(new AppError(ErrorCode.Internal, "团队服务暂不可用").toBody(), 500);
  });
  app.get("/health", (c) => c.json({ ok: true, service: "agentdesk-team" }));
  app.route(
    "/team-api/v1",
    teamRoutes(service, {
      adminKey: options.adminKey,
      allowedOrigins: options.publicOrigin ? [options.publicOrigin] : [],
    }),
  );
  if (options.webRoot) {
    app.get("/assets/*", serveStatic({ root: options.webRoot }));
    app.get("/reference/*", serveStatic({ root: options.webRoot }));
    app.get("/", serveStatic({ path: `${options.webRoot}/index.html` }));
  }
  return app;
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { AppError, ErrorCode, httpStatusOf } from "@agentdesk/shared";
import type { Container } from "../container";
import { chatRoutes } from "./routes/chat";
import { deployRoutes } from "./routes/deploy";
import { feedRoutes } from "./routes/feed";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { systemRoutes } from "./routes/system";
import { workflowRoutes } from "./routes/workflows";

export function createApp(container: Container): Hono {
  const app = new Hono();
  const { config } = container;

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "X-AgentDesk-Token"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // 本机回环 + 会话令牌：防止其他本地网页或进程调用 sidecar
  app.use("/api/*", async (c, next) => {
    if (!config.token || c.req.method === "OPTIONS") return next();
    const token = c.req.header("x-agentdesk-token") ?? c.req.query("token");
    if (token !== config.token) throw new AppError(ErrorCode.Unauthorized, "无效的会话令牌");
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toBody(), httpStatusOf(error.code) as 400);
    }
    if (error instanceof ZodError) {
      const body = new AppError(ErrorCode.BadRequest, "参数校验失败", error.issues).toBody();
      return c.json(body, 400);
    }
    console.error("[sidecar] unhandled error", error);
    return c.json(new AppError(ErrorCode.Internal, error.message || "内部错误").toBody(), 500);
  });

  app.route("/api", systemRoutes(container));
  app.route("/api", providerRoutes(container));
  app.route("/api", projectRoutes(container));
  app.route("/api", feedRoutes(container));
  app.route("/api", deployRoutes(container));
  app.route("/api", chatRoutes(container));
  app.route("/api", workflowRoutes(container));

  app.notFound((c) =>
    c.json(new AppError(ErrorCode.NotFound, `接口不存在：${c.req.path}`).toBody(), 404),
  );
  return app;
}

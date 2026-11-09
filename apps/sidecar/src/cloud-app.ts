import { Hono } from "hono";
import { ZodError } from "zod";
import { AppError, ErrorCode, httpStatusOf } from "@agentdesk/shared";
import type { Container } from "./container";
import type { CloudConfig } from "./cloud-config";
import { remoteRoutes } from "./http/routes/remote";

export function createCloudApp(container: Container, cloudConfig: CloudConfig): Hono {
  const app = new Hono();
  const mounted = { ...container, cloudConfig };
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toBody(), httpStatusOf(error.code) as 400);
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const body = new AppError(ErrorCode.BadRequest, "Remote request validation failed").toBody();
      return c.json(body, 400);
    }
    console.error("[cloud-runner] request failed");
    return c.json(new AppError(ErrorCode.Internal, "Internal runner error").toBody(), 500);
  });
  app.route("/remote-api/v1", remoteRoutes(mounted));
  app.notFound((c) => c.json(new AppError(ErrorCode.NotFound, "Route not found").toBody(), 404));
  return app;
}

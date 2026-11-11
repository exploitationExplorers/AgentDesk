import { Hono } from "hono";
import { AppError, ErrorCode } from "@agentdesk/shared";
import type { Container } from "../../container";

export function promptOptimizationRoutes({
  promptOptimization,
}: Pick<Container, "promptOptimization">) {
  const app = new Hono();
  app.post("/prompt-optimizations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError(ErrorCode.BadRequest, "请求内容必须是有效的 JSON");
    }
    return c.json(await promptOptimization.optimize(body, c.req.raw.signal));
  });
  return app;
}

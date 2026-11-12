import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";
export function projectInsightRoutes({ insights }: Container) {
  const app = new Hono();
  app.get("/project-insights", (c) => c.json(insights.list(c.req.query("projectId"))));
  app.get("/project-insights/:id", (c) => c.json(insights.get(c.req.param("id"))));
  app.post("/project-insights", async (c) =>
    c.json(await insights.start(await c.req.json(), c.req.raw.signal), 201),
  );
  app.post("/project-insights/:id/tasks", async (c) => {
    const body = z
      .object({ ids: z.array(z.string().min(1)).min(1).max(12) })
      .parse(await c.req.json());
    return c.json(await insights.createTasks(c.req.param("id"), body.ids), 201);
  });
  return app;
}

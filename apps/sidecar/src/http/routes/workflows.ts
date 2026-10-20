import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";
import { workflowChannel } from "../../services/workflows";
import { channelToSse } from "../sse";

export function workflowRoutes({ workflows, hub }: Container) {
  const app = new Hono();

  app.get("/workflows", (c) => c.json(workflows.list()));
  app.get("/workflow-templates", (c) => c.json(workflows.templates()));
  app.post("/workflows/from-template", async (c) => {
    const { key } = z.object({ key: z.string() }).parse(await c.req.json());
    return c.json(workflows.createFromTemplate(key), 201);
  });
  app.post("/workflows", async (c) => c.json(workflows.save(await c.req.json()), 201));
  app.get("/workflows/:id", (c) => c.json(workflows.get(c.req.param("id"))));
  app.put("/workflows/:id", async (c) =>
    c.json(workflows.save(await c.req.json(), c.req.param("id"))),
  );
  app.delete("/workflows/:id", (c) => {
    workflows.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/workflows/:id/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, string> };
    return c.json(workflows.run(c.req.param("id"), body.inputs ?? {}), 202);
  });

  app.get("/workflow-runs", (c) =>
    c.json(workflows.listRuns(c.req.query("workflowId") || undefined)),
  );
  app.get("/workflow-runs/:id", (c) => c.json(workflows.getRun(c.req.param("id"))));
  app.post("/workflow-runs/:id/cancel", (c) => {
    workflows.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/workflow-runs/:id/events", (c) =>
    channelToSse(
      c,
      hub,
      workflowChannel(c.req.param("id")),
      (e) => (e as { type?: string }).type === "run_end",
    ),
  );

  return app;
}

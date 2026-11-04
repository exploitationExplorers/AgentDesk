import { Hono } from "hono";
import { ReachRequest, ReachSettings } from "@agentdesk/shared";
import type { Container } from "../../container";

export function reachRoutes({ reach }: Container) {
  const app = new Hono();
  app.get("/reach/capabilities", (c) => c.json(reach.capabilities()));
  app.get("/reach/status", (c) => c.json(reach.status()));
  app.get("/reach/settings", (c) => c.json(reach.getSettings()));
  app.put("/reach/settings", async (c) =>
    c.json(reach.updateSettings(ReachSettings.parse(await c.req.json()))),
  );
  app.post("/reach/run", async (c) =>
    c.json(await reach.run(ReachRequest.parse(await c.req.json()), c.req.raw.signal)),
  );
  return app;
}

import { Hono } from "hono";
import { AppSettings, type HealthInfo } from "@agentdesk/shared";
import type { Container } from "../../container";
import { GLOBAL_CHANNEL } from "../../events";
import { applyProxy, resolveProxy } from "../../proxy";
import { channelToSse } from "../sse";

export function systemRoutes(container: Container) {
  const { config, settings, approvals, skills, registry, hub, providers } = container;
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: config.version,
      dataDir: config.dataDir,
      secretBackend: container.secrets.backend,
      providers: providers.list().length,
      proxy: resolveProxy(settings.get().proxy),
    } satisfies HealthInfo),
  );

  app.get("/settings", (c) => c.json(settings.get()));
  app.put("/settings", async (c) => {
    const next = settings.update(AppSettings.partial().parse(await c.req.json()));
    applyProxy(resolveProxy(next.proxy));
    return c.json(next);
  });

  app.get("/approvals", (c) => {
    const status = c.req.query("status") as "pending" | undefined;
    return c.json(approvals.list(status));
  });
  app.post("/approvals/:id", async (c) => {
    const body = (await c.req.json()) as { approved?: boolean };
    return c.json(approvals.resolve(c.req.param("id"), body.approved === true));
  });

  app.get("/skills", (c) =>
    c.json(
      skills.list().map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        agents: s.agents,
        triggers: s.triggers,
        dir: s.dir,
      })),
    ),
  );

  app.get("/tools", (c) =>
    c.json(
      registry.list().map((t) => ({ name: t.name, description: t.description, risk: t.risk })),
    ),
  );

  app.get("/events", (c) => channelToSse(c, hub, GLOBAL_CHANNEL));

  return app;
}

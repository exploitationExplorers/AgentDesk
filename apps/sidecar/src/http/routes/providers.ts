import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";

const ImportSource = z.enum(["dotenv", "cc-switch"]);

export function providerRoutes({ providers }: Container) {
  const app = new Hono();

  app.get("/providers", (c) => c.json(providers.list()));
  app.post("/providers", async (c) => c.json(providers.create(await c.req.json()), 201));
  app.put("/providers/:id", async (c) =>
    c.json(providers.update(c.req.param("id"), await c.req.json())),
  );
  app.delete("/providers/:id", (c) => {
    providers.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/providers/:id/test", async (c) => c.json(await providers.test(c.req.param("id"))));
  app.get("/providers/:id/remote-models", async (c) =>
    c.json(await providers.remoteModels(c.req.param("id"))),
  );

  app.get("/providers/import/candidates", async (c) => {
    const source = ImportSource.parse(c.req.query("source"));
    return c.json(await providers.candidates(source, c.req.query("path") || undefined));
  });
  app.post("/providers/import", async (c) => {
    const body = z
      .object({
        source: ImportSource,
        candidateIds: z.array(z.string()).min(1),
        path: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(await providers.import(body.source, body.candidateIds, body.path));
  });

  app.get("/agent-bindings", (c) => c.json(providers.listBindings()));
  app.put("/agent-bindings", async (c) => c.json(providers.setBindings(await c.req.json())));

  return app;
}

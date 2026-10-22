import { Hono } from "hono";
import { z } from "zod";
import { DiskCleanRequest } from "@agentdesk/shared";
import type { Container } from "../../container";

export function diskRoutes({ disk }: Container) {
  const app = new Hono();

  app.get("/disk/status", (c) => c.json(disk.status()));
  app.get("/disk/scan", (c) => c.json(disk.current()));
  app.post("/disk/scan", async (c) => c.json(await disk.scan()));
  app.post("/disk/review", async (c) => {
    const body = z.object({ scanId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await disk.review(body.scanId));
  });
  app.post("/disk/clean", async (c) => {
    const body = DiskCleanRequest.parse(await c.req.json());
    return c.json(await disk.clean(body));
  });
  app.post("/disk/reveal", async (c) => {
    const body = z
      .object({ scanId: z.string().min(1), id: z.string().min(1) })
      .parse(await c.req.json());
    disk.reveal(body.scanId, body.id);
    return c.json({ ok: true });
  });

  return app;
}

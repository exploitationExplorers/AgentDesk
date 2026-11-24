import { Hono } from "hono";
import { z } from "zod";
import { DiskCleanCommitRequest, DiskCleanRequest, DiskScanRequest } from "@agentdesk/shared";
import type { Container } from "../../container";

export function diskRoutes({ disk }: Container) {
  const app = new Hono();

  app.get("/disk/status", async (c) => c.json(await disk.status()));
  app.get("/disk/scan", (c) => c.json(disk.current()));
  app.post("/disk/scan", async (c) => {
    const text = await c.req.text();
    const body = DiskScanRequest.parse(text.trim() ? JSON.parse(text) : {});
    return c.json(await disk.scan(body.volumePath));
  });
  app.post("/disk/review", async (c) => {
    const body = z.object({ scanId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await disk.review(body.scanId));
  });
  app.post("/disk/inspect", async (c) => {
    const body = z
      .object({ volumePath: z.string().min(1), path: z.string().min(1).max(4096) })
      .parse(await c.req.json());
    return c.json(await disk.inspectDirectory(body.volumePath, body.path));
  });
  app.post("/disk/plan", async (c) => {
    return c.json(disk.planClean(DiskCleanRequest.parse(await c.req.json())));
  });
  app.post("/disk/clean", async (c) => {
    const body = DiskCleanCommitRequest.parse(await c.req.json());
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

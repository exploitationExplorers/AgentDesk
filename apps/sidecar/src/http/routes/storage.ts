import { Hono } from "hono";
import { z } from "zod";
import type { StorageService } from "../../services/storage/service";

export function storageRoutes(storage: StorageService) {
  const app = new Hono();
  app.get("/storage/policy", (c) => c.json(storage.policy()));
  app.put("/storage/policy", async (c) => c.json(storage.updatePolicy(await c.req.json())));
  app.get("/storage/usage", async (c) => c.json(await storage.usage()));
  app.post("/storage/cleanup/preview", async (c) => c.json(await storage.preview()));
  app.post("/storage/cleanup", async (c) => {
    const { previewId } = z.strictObject({ previewId: z.uuid() }).parse(await c.req.json());
    return c.json(await storage.cleanup(previewId));
  });
  return app;
}

import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";

export function wechatRoutes({ wechat }: Container) {
  const app = new Hono();

  app.get("/skills/wechat/status", async (c) => c.json(await wechat.status()));
  app.post("/skills/wechat/decrypt", async (c) => c.json(await wechat.decrypt()));
  app.get("/skills/wechat/groups", async (c) => c.json(await wechat.listGroups()));
  app.get("/skills/wechat/reports", (c) => c.json(wechat.listJobs()));
  app.get("/skills/wechat/reports/:id", (c) => c.json(wechat.getJob(c.req.param("id"))));
  app.post("/skills/wechat/reports", async (c) => {
    const body = z
      .object({
        chatroom: z.string().min(1),
        date: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(wechat.startReport(body), 201);
  });
  app.get("/skills/wechat/reports/:id/image", async (c) => {
    const file = wechat.resolveReportPath(c.req.param("id"));
    return c.body(new Uint8Array(await readFile(file)), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
    });
  });

  return app;
}

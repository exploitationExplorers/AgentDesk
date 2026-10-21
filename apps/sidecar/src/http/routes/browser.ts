import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { BrowserActionInput } from "@agentdesk/shared";
import type { Container } from "../../container";
import { browserChannel } from "../../services/browser";
import { channelToSse } from "../sse";

export function browserRoutes({ browser, hub }: Container) {
  const app = new Hono();

  app.get("/browser/sessions", (c) => c.json(browser.list()));

  app.post("/browser/sessions", async (c) => {
    const body = z
      .object({
        sessionId: z.string().optional(),
        url: z.string().optional(),
        headless: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await browser.open(body), 201);
  });

  app.get("/browser/sessions/:id", (c) => c.json(browser.get(c.req.param("id"))));

  app.delete("/browser/sessions/:id", async (c) => {
    await browser.close(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/browser/sessions/:id/actions", async (c) => {
    const action = BrowserActionInput.parse(await c.req.json());
    return c.json(await browser.act(c.req.param("id"), action));
  });

  app.post("/browser/sessions/:id/snapshot", async (c) =>
    c.json(await browser.snapshot(c.req.param("id"))),
  );

  app.post("/browser/sessions/:id/reveal", async (c) =>
    c.json(await browser.reveal(c.req.param("id"))),
  );

  app.get("/browser/sessions/:id/events", (c) =>
    channelToSse(c, hub, browserChannel(c.req.param("id")), (e) => {
      const ev = e as { type?: string };
      return ev.type === "closed";
    }),
  );

  app.get("/browser/sessions/:id/shots/:file", async (c) => {
    const file = browser.resolveShotPath(c.req.param("id"), c.req.param("file"));
    return c.body(new Uint8Array(await readFile(file)), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
    });
  });

  return app;
}

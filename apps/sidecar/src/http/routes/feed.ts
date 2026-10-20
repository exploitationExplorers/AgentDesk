import { Hono } from "hono";
import { FeedSource } from "@agentdesk/shared";
import type { Container } from "../../container";

export function feedRoutes({ feed }: Container) {
  const app = new Hono();

  app.get("/feed", (c) => {
    const source = c.req.query("source");
    return c.json(
      feed.list({
        date: c.req.query("date") || undefined,
        source: source ? FeedSource.parse(source) : undefined,
        tag: c.req.query("tag") || undefined,
        favorite: c.req.query("favorite") === "true",
        q: c.req.query("q") || undefined,
      }),
    );
  });
  app.get("/feed/dates", (c) => c.json(feed.dates()));
  app.post("/feed/refresh", async (c) => c.json(await feed.refresh()));
  app.post("/feed/:id/favorite", (c) =>
    c.json(feed.toggleFavorite(decodeURIComponent(c.req.param("id")))),
  );
  app.get("/feed/digest", (c) => c.json(feed.getDigest(c.req.query("date") || undefined)));
  app.post("/feed/digest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { date?: string };
    return c.json(await feed.generateDigest(body.date));
  });

  return app;
}

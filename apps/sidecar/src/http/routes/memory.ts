import { Hono } from "hono";
import type { Container } from "../../container";

export function memoryRoutes({ memory }: Container) {
  const app = new Hono();
  app.get("/memories", (c) => c.json(memory.list()));
  app.delete("/memories/:id", (c) => c.json(memory.forget(c.req.param("id"))));
  return app;
}

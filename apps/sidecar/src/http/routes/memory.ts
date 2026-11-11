import { Hono } from "hono";
import { MemoryCorrection, MemoryPolicyPatch } from "@agentdesk/shared";
import type { Container } from "../../container";

export function memoryRoutes({ memory }: Container) {
  const app = new Hono();
  app.get("/memories", (c) => c.json(memory.withManagement(() => memory.listAll())));
  app.get("/memories/policy", (c) => c.json(memory.getPolicy()));
  app.put("/memories/policy", async (c) =>
    c.json(memory.updatePolicy(MemoryPolicyPatch.parse(await c.req.json()))),
  );
  app.post("/memories/:id/approve", (c) =>
    c.json(memory.withManagement(() => memory.approve(c.req.param("id")))),
  );
  app.put("/memories/:id", async (c) => {
    const patch = MemoryCorrection.parse(await c.req.json());
    return c.json(memory.withManagement(() => memory.correct(c.req.param("id"), patch)));
  });
  app.delete("/memories/:id", (c) =>
    c.json(memory.withManagement(() => memory.forget(c.req.param("id")))),
  );
  return app;
}

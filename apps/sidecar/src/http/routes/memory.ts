import { Hono } from "hono";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  MemoryCorrection,
  MemoryCreate,
  MemoryPolicyPatch,
} from "@agentdesk/shared";
import type { Container } from "../../container";

export function memoryRoutes({ memory, projectInstructions }: Container) {
  const app = new Hono();
  app.get("/memories", (c) => c.json(memory.withManagement(() => memory.listAll())));
  app.get("/memories/index", async (c) => {
    const workspace = c.req.query("workspace");
    const repositoryRoot = await projectInstructions.memoryRoot(workspace, c.req.raw.signal);
    return c.json(memory.withContext({ workspace, repositoryRoot }, () => memory.index()));
  });
  app.post("/memories/replay", async (c) => {
    const { workspace } = z
      .object({ workspace: z.string().min(1) })
      .parse(await c.req.json().catch(() => null));
    const signal = c.req.raw.signal;
    const repositoryRoot = await projectInstructions.memoryRoot(workspace, signal);
    return c.json(
      await memory.withContext({ workspace, repositoryRoot }, () => memory.replay(signal)),
    );
  });
  app.post("/memories", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new AppError(ErrorCode.BadRequest, "请求内容必须是有效的 JSON");
    });
    const input = MemoryCreate.parse(body);
    return c.json(memory.store({ ...input, source: "tool" }).memory);
  });
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

import { Hono } from "hono";
import {
  AppError,
  ErrorCode,
  EvaluationInput,
  EvolutionPublishInput,
  EvolutionRollbackInput,
} from "@agentdesk/shared";
import type { Container } from "../../container";

const EvaluateProposal = EvaluationInput.omit({ baseline: true, candidate: true }).strict();

async function readBody(request: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError(ErrorCode.BadRequest, "请求内容必须是有效的 JSON");
  }
}

export function evolutionRoutes({
  evolution,
  cloudRunner,
}: Pick<Container, "evolution" | "cloudRunner">) {
  const app = new Hono();
  app.use("/evolution/*", async (_c, next) => {
    if (cloudRunner) throw new AppError(ErrorCode.Forbidden, "个人记忆与改进仅在本地工作台管理");
    await next();
  });
  app.get("/evolution", (c) => {
    if (cloudRunner) throw new AppError(ErrorCode.Forbidden, "改进工作台仅在本地提供");
    return c.json(evolution.overview());
  });
  app.get("/evolution/evidence", (c) => c.json(evolution.evidence()));
  app.post("/evolution/proposals", async (c) => c.json(evolution.create(await readBody(c.req))));
  app.post("/evolution/proposals/generate", async (c) =>
    c.json(await evolution.generate(await readBody(c.req), c.req.raw.signal)),
  );
  app.post("/evolution/proposals/:id/evaluate", async (c) => {
    const input = EvaluateProposal.parse(await readBody(c.req));
    return c.json(await evolution.evaluate(c.req.param("id"), input, c.req.raw.signal));
  });
  app.post("/evolution/proposals/:id/publish", async (c) => {
    const input = EvolutionPublishInput.parse(await readBody(c.req));
    return c.json(evolution.publish(c.req.param("id"), input.evaluationId));
  });
  app.post("/evolution/proposals/:id/reject", (c) => c.json(evolution.reject(c.req.param("id"))));
  app.post("/evolution/rollback", async (c) => {
    const input = EvolutionRollbackInput.parse(await readBody(c.req));
    return c.json(evolution.rollback(input.versionId));
  });
  app.post("/evolution/feedback", async (c) => c.json(evolution.feedback(await readBody(c.req))));
  return app;
}

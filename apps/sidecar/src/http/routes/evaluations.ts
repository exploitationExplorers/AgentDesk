import { Hono } from "hono";
import { AppError, ErrorCode } from "@agentdesk/shared";
import type { EvaluationService } from "../../services/evaluation";

/** 写入与执行只能经过 evolution 服务解析可信版本，不能由 HTTP 客户端提交分数。 */
export function evaluationRoutes({
  evaluation,
  cloudRunner,
}: {
  evaluation: EvaluationService;
  cloudRunner?: unknown;
}) {
  const app = new Hono();
  app.use("/evaluations*", async (_c, next) => {
    if (cloudRunner) throw new AppError(ErrorCode.Forbidden, "本地评测记录不向云端工作台开放");
    await next();
  });
  app.get("/evaluations/datasets", (c) => c.json(evaluation.datasets()));
  app.get("/evaluations", (c) => c.json(evaluation.list()));
  app.get("/evaluations/:id", (c) => c.json(evaluation.get(c.req.param("id"))));
  return app;
}

import {
  InterviewBatchInput,
  InterviewReviewInput,
  InterviewSettingsInput,
} from "@agentdesk/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Container } from "../../container";

export function interviewRoutes({ interview }: Pick<Container, "interview">) {
  const app = new Hono();
  const base = "/learning/interview";
  app.use(
    `${base}/*`,
    bodyLimit({
      maxSize: 32 * 1024 ** 2,
      onError: (c) =>
        c.json({ error: { code: "BAD_REQUEST", message: "单批导入超过 32 MB，请分批上传" } }, 413),
    }),
  );
  app.get(`${base}/sources`, (c) => c.json(interview.listSources()));
  app.post(`${base}/imports`, async (c) =>
    c.json(interview.import(InterviewBatchInput.parse(await c.req.json()).items), 202),
  );
  app.post(`${base}/sources/:id/retry`, (c) => c.json(interview.retry(c.req.param("id")), 202));
  app.delete(`${base}/sources/:id`, (c) => {
    interview.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get(`${base}/questions`, (c) => {
    const query = z
      .object({
        search: z.string().max(500).optional(),
        sourceId: z.string().max(100).optional(),
        category: z.string().max(100).optional(),
        filter: z.enum(["all", "favorite", "due", "new", "learning", "mastered"]).optional(),
        page: z.coerce.number().int().min(1).max(100000).optional(),
      })
      .parse(c.req.query());
    return c.json(interview.list(query));
  });
  app.patch(`${base}/questions/:id`, async (c) =>
    c.json(
      interview.favorite(
        c.req.param("id"),
        z.object({ favorite: z.boolean() }).parse(await c.req.json()).favorite,
      ),
    ),
  );
  app.post(`${base}/questions/:id/reviews`, async (c) =>
    c.json(interview.review(c.req.param("id"), InterviewReviewInput.parse(await c.req.json()))),
  );
  app.get(`${base}/stats`, (c) => c.json(interview.stats()));
  app.post(`${base}/checkin`, (c) => c.json(interview.checkin()));
  app.get(`${base}/settings`, (c) => c.json(interview.settings()));
  app.put(`${base}/settings`, async (c) =>
    c.json(interview.saveSettings(InterviewSettingsInput.parse(await c.req.json()))),
  );
  return app;
}

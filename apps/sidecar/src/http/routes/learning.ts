import { ImportSourceInput, LearningPlanInput, LearningProfileInput } from "@agentdesk/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";
import { parseArticle, readDocsOutline } from "../../services/docs-article";
import { readPublicArticle } from "../../services/insight-source";

export function learningRoutes({ learning, library }: Container) {
  const app = new Hono();

  app.get("/learning/today", (c) => c.json(learning.today(c.req.query("date") || undefined)));

  app.get("/learning/profiles", (c) => c.json(learning.listProfiles()));
  app.post("/learning/profiles", async (c) =>
    c.json(learning.createProfile(LearningProfileInput.parse(await c.req.json())), 201),
  );

  app.post("/learning/skill-suggestions", async (c) => {
    const body = z
      .object({ profession: z.string().min(1), targetRole: z.string().nullable().optional() })
      .parse(await c.req.json());
    return c.json(await learning.suggestSkills(body.profession, body.targetRole, c.req.raw.signal));
  });

  app.get("/learning/plans", (c) =>
    c.json(learning.listPlans(c.req.query("profileId") || undefined)),
  );
  app.post("/learning/plans", async (c) =>
    c.json(
      await learning.createPlan(LearningPlanInput.parse(await c.req.json()), c.req.raw.signal),
      201,
    ),
  );

  app.post("/learning/activities/:id/status", async (c) => {
    const { status } = z
      .object({ status: z.enum(["pending", "done", "skipped"]) })
      .parse(await c.req.json());
    return c.json(learning.setActivityStatus(c.req.param("id"), status));
  });

  app.get("/learning/outline", async (c) => {
    const url = z.string().url().parse(c.req.query("url"));
    return c.json(await readDocsOutline(url, c.req.raw.signal));
  });
  app.get("/learning/page", async (c) => {
    const url = z.string().url().parse(c.req.query("url"));
    const markdown = await readPublicArticle(url, c.req.raw.signal);
    return c.json({ url, blocks: parseArticle(markdown) });
  });

  app.get("/learning/sources", (c) => c.json(library.listSources()));
  app.post("/learning/sources", async (c) =>
    c.json(
      await library.importSource(ImportSourceInput.parse(await c.req.json()), c.req.raw.signal),
      201,
    ),
  );
  app.get("/learning/sources/:id/units", (c) => c.json(library.listUnits(c.req.param("id"))));
  app.delete("/learning/sources/:id", (c) => {
    library.deleteSource(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/learning/review", (c) => c.json(library.reviewQueue(c.req.query("date") || undefined)));
  app.post("/learning/review/:id/grade", async (c) => {
    const { rating } = z
      .object({ rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) })
      .parse(await c.req.json());
    return c.json(library.grade(c.req.param("id"), rating));
  });

  return app;
}

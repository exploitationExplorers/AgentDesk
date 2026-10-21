import { Hono } from "hono";
import { z } from "zod";
import { LaunchTarget } from "@agentdesk/shared";
import type { Container } from "../../container";

export function projectRoutes({ projects }: Container) {
  const app = new Hono();

  app.get("/projects", (c) => c.json(projects.list()));
  app.post("/projects/scan", async (c) => c.json(await projects.scan()));
  app.post("/projects/refresh-stars", async (c) => c.json(await projects.refreshStars()));
  app.post("/projects", async (c) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
    return c.json(await projects.add(path), 201);
  });
  app.get("/projects/remote", async (c) => {
    const platform = z
      .enum(["github", "gitee", "gitlab"])
      .parse(c.req.query("platform") || "gitee");
    return c.json(await projects.listRemoteRepos(platform));
  });
  app.post("/projects/import-remote", async (c) => {
    const body = z
      .object({
        platform: z.enum(["github", "gitee", "gitlab"]),
        cloneUrl: z.string().min(1),
        fullName: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await projects.importRemoteRepo(body.platform, body.cloneUrl, body.fullName),
      201,
    );
  });
  app.patch("/projects/:id", async (c) => {
    const patch = z
      .object({ pinned: z.boolean().optional(), tags: z.array(z.string()).optional() })
      .parse(await c.req.json());
    return c.json(projects.patch(c.req.param("id"), patch));
  });
  app.delete("/projects/:id", (c) => {
    projects.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/projects/:id/refresh", async (c) => c.json(await projects.refresh(c.req.param("id"))));
  app.get("/projects/:id/activity", async (c) =>
    c.json(await projects.activity(c.req.param("id"))),
  );
  app.get("/projects/:id/commits", async (c) => c.json(await projects.commits(c.req.param("id"))));
  app.post("/projects/:id/pull", async (c) =>
    c.json({ output: await projects.pull(c.req.param("id")) }),
  );
  app.post("/projects/:id/ai-commit/preview", async (c) =>
    c.json(await projects.prepareAiCommit(c.req.param("id"))),
  );
  app.post("/projects/:id/ai-commit", async (c) =>
    c.json(await projects.startAiCommit(c.req.param("id"), await c.req.json())),
  );
  app.get("/projects/:id/ai-commit/jobs/:jobId", async (c) =>
    c.json(await projects.getAiCommitJob(c.req.param("id"), c.req.param("jobId"))),
  );
  app.post("/projects/:id/launch", async (c) => {
    const { target } = z.object({ target: LaunchTarget }).parse(await c.req.json());
    return c.json(projects.launch(c.req.param("id"), target));
  });

  app.get("/claude/sessions", async (c) =>
    c.json(await projects.claudeSessions(c.req.query("projectId") || undefined)),
  );

  app.get("/git-accounts", (c) => c.json(projects.listAccounts()));
  app.put("/git-accounts", async (c) => {
    const body = z
      .object({
        platform: z.enum(["github", "gitee", "gitlab"]),
        host: z.string().optional(),
        token: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(projects.saveAccount(body));
  });
  app.delete("/git-accounts/:id", (c) => {
    projects.deleteAccount(decodeURIComponent(c.req.param("id")));
    return c.body(null, 204);
  });

  return app;
}

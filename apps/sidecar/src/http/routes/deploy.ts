import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../container";
import { deployChannel } from "../../services/deploy";
import { channelToSse } from "../sse";

const PresetOptions = z.object({
  remoteDir: z.string().min(1),
  branch: z.string().optional(),
  buildCommand: z.string().optional(),
  projectType: z.enum(["node", "java", "go", "python", "php"]),
  projectName: z.string().min(1),
  healthUrl: z.string().optional(),
});

export function deployRoutes({ deploy, hub }: Container) {
  const app = new Hono();

  app.get("/servers", (c) => c.json(deploy.listServers()));
  app.post("/servers", async (c) => c.json(deploy.saveServer(await c.req.json()), 201));
  app.put("/servers/:id", async (c) =>
    c.json(deploy.saveServer(await c.req.json(), c.req.param("id"))),
  );
  app.delete("/servers/:id", async (c) => {
    await deploy.deleteServer(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/servers/:id/open", async (c) => {
    await deploy.openPanel(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/recipes", (c) => c.json(deploy.listRecipes()));
  app.get("/recipes/presets", (c) => c.json(deploy.presets()));
  app.post("/recipes/preset-steps", async (c) =>
    c.json(deploy.buildPresetSteps(PresetOptions.parse(await c.req.json()))),
  );
  app.post("/recipes", async (c) => c.json(deploy.saveRecipe(await c.req.json()), 201));
  app.put("/recipes/:id", async (c) =>
    c.json(deploy.saveRecipe(await c.req.json(), c.req.param("id"))),
  );
  app.delete("/recipes/:id", (c) => {
    deploy.deleteRecipe(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/recipes/:id/run", (c) => c.json(deploy.start(c.req.param("id")), 202));

  app.get("/deploy/runs", (c) => c.json(deploy.listRuns(c.req.query("recipeId") || undefined)));
  app.get("/deploy/runs/:id", (c) => c.json(deploy.getRun(c.req.param("id"))));
  app.post("/deploy/runs/:id/retry", (c) => c.json(deploy.retry(c.req.param("id"))));
  app.post("/deploy/runs/:id/cancel", (c) => c.json(deploy.cancel(c.req.param("id"))));
  app.get("/deploy/runs/:id/screenshots/:index", async (c) => {
    const file = deploy.screenshotPath(c.req.param("id"), Number(c.req.param("index")));
    return c.body(new Uint8Array(await readFile(file)), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
    });
  });
  app.get("/deploy/runs/:id/events", (c) => {
    const id = c.req.param("id");
    return channelToSse(c, hub, deployChannel(id), (event) => {
      const run = (event as { run?: { status: string } }).run;
      return !!run && ["succeeded", "failed", "cancelled"].includes(run.status);
    });
  });

  return app;
}

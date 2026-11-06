import { Hono } from "hono";
import {
  AppError,
  AutomationBindingInput,
  AutomationFollowupInput,
  AutoloopEventInput,
  AutoloopInteractionAnswer,
  ErrorCode,
} from "@agentdesk/shared";
import type { Container } from "../../container";

export function autoloopRoutes({ autoloop }: Pick<Container, "autoloop">) {
  const app = new Hono();
  app.get("/autoloop/status", (c) => c.json(autoloop.status()));
  app.get("/automations", (c) => c.json(autoloop.listBindings()));
  app.post("/automations", async (c) =>
    c.json(await autoloop.createBinding(AutomationBindingInput.parse(await c.req.json())), 201),
  );
  app.get("/automations/:id", (c) => {
    const binding = autoloop.getBinding(c.req.param("id"));
    if (!binding) throw new AppError(ErrorCode.NotFound, "自动化不存在");
    return c.json(binding);
  });
  app.post("/automations/:id/disable", async (c) =>
    c.json(await autoloop.disableBinding(c.req.param("id"))),
  );
  app.post("/automations/:id/trigger", async (c) =>
    c.json(
      await autoloop.trigger(c.req.param("id"), AutoloopEventInput.parse(await c.req.json())),
      202,
    ),
  );
  app.get("/automations/:id/tasks", (c) => c.json(autoloop.listTasks(c.req.param("id"))));
  app.get("/interactions", (c) => c.json(autoloop.listInteractions(c.req.query("taskId"))));
  app.post("/interactions/:id/answer", async (c) =>
    c.json(
      await autoloop.answerInteraction(
        c.req.param("id"),
        AutoloopInteractionAnswer.parse(await c.req.json()),
      ),
    ),
  );
  app.post("/automation-tasks/:id/cancel", async (c) =>
    c.json(await autoloop.cancelTask(c.req.param("id")), 202),
  );
  app.post("/automation-tasks/:id/resume", async (c) =>
    c.json(await autoloop.resumeTask(c.req.param("id")), 202),
  );
  app.post("/automation-tasks/:id/followup", async (c) =>
    c.json(
      await autoloop.followupTask(
        c.req.param("id"),
        AutomationFollowupInput.parse(await c.req.json()),
      ),
      202,
    ),
  );
  return app;
}

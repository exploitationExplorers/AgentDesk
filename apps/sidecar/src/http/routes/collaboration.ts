import { Hono } from "hono";
import type { Container } from "../../container";

/** 沿用 /api 的回环令牌鉴权；所有作者身份均由 CollaborationService 确定。 */
export function collaborationRoutes({ collaboration }: Pick<Container, "collaboration">) {
  const app = new Hono();
  app.get("/collaboration/sources", (c) => c.json(collaboration.sources()));
  app.get("/collaboration/members", async (c) => c.json(await collaboration.listMembers()));
  app.post("/collaboration/members", async (c) =>
    c.json(await collaboration.createMember(await c.req.json()), 201),
  );
  app.get("/collaboration/rooms", async (c) => c.json(await collaboration.listRooms()));
  app.post("/collaboration/rooms", async (c) =>
    c.json(await collaboration.createRoom(await c.req.json()), 201),
  );
  app.get("/collaboration/rooms/:id", async (c) =>
    c.json(await collaboration.detail(c.req.param("id"))),
  );
  app.post("/collaboration/rooms/:id/messages", async (c) =>
    c.json(await collaboration.postMessage(c.req.param("id"), await c.req.json())),
  );
  app.post("/collaboration/rooms/:id/discuss", async (c) =>
    c.json(await collaboration.discuss(c.req.param("id"), await c.req.json())),
  );
  app.post("/collaboration/rooms/:id/stop", async (c) =>
    c.json(await collaboration.stop(c.req.param("id"))),
  );
  app.post("/collaboration/rooms/:id/decision", async (c) =>
    c.json(await collaboration.decide(c.req.param("id"), await c.req.json())),
  );
  return app;
}

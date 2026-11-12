import { Hono } from "hono";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteActor,
  StoragePolicy,
  StorageCleanupInput,
} from "@agentdesk/shared";
import type { CloudConfig } from "../../cloud-config";
import type { StorageService } from "../../services/storage/service";

export function cloudStorageRoutes(
  storage: StorageService,
  config: Pick<CloudConfig, "kind" | "ownerUserId" | "hostId">,
) {
  const app = new Hono();
  // 容量和清理影响整个宿主，不能由项目授权推导出全局管理权限。
  const authorize = (actor: RemoteActor, write: boolean) => {
    if (config.kind === "office" || actor.userId !== config.ownerUserId)
      throw new AppError(ErrorCode.Forbidden, "Only the cloud host owner can manage storage");
    const age = Date.now() - Date.parse(actor.recentAuthAt);
    if (write && (!Number.isFinite(age) || age > 15 * 60_000 || age < -5_000))
      throw new AppError(ErrorCode.Unauthorized, "Recent owner authentication is required");
    return JSON.stringify([actor.userId, actor.sessionId]);
  };
  app.post("/status", async (c) => {
    const { actor } = z.strictObject({ actor: RemoteActor }).parse(await c.req.json());
    authorize(actor, false);
    return c.json({
      hostId: config.hostId,
      policy: storage.policy(),
      usage: await storage.usage(),
    });
  });
  app.put("/policy", async (c) => {
    const { actor, policy } = z
      .strictObject({ actor: RemoteActor, policy: StoragePolicy.strict() })
      .parse(await c.req.json());
    authorize(actor, true);
    return c.json(storage.updatePolicy(policy));
  });
  app.post("/cleanup/preview", async (c) => {
    const { actor } = z.strictObject({ actor: RemoteActor }).parse(await c.req.json());
    return c.json(await storage.preview(authorize(actor, true)));
  });
  app.post("/cleanup", async (c) => {
    const { actor, previewId } = StorageCleanupInput.extend({ actor: RemoteActor }).parse(
      await c.req.json(),
    );
    return c.json(await storage.cleanup(previewId, authorize(actor, true)));
  });
  return app;
}

import type { Context, Env, Hono } from "hono";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  StoragePolicy,
  StorageCleanupInput,
  type RemoteActor,
} from "@agentdesk/shared";
import type { RunnerClient } from "./remote/client";
import type { GatewayStore } from "./db/store";
export function registerStorageRoutes<E extends Env>(
  app: Hono<E>,
  deps: {
    runner: RunnerClient;
    store: GatewayStore;
    loggedIn: (c: Context) => Promise<{
      actor: RemoteActor;
      isOwner: boolean;
    }>;
  },
) {
  const handle = async (c: Context) => {
    const { actor, isOwner } = await deps.loggedIn(c);
    if (c.req.param("hostId") !== "cloud" || !isOwner)
      throw new AppError(ErrorCode.Forbidden, "仅云宿主 owner 可管理服务器存储");
    const runner = deps.runner.forHost("cloud");
    const tail = new URL(c.req.url).pathname.slice("/api/v1/hosts/cloud/storage".length);
    if (!tail && c.req.method === "GET")
      return c.json(await runner.json("/host/storage/status", { actor }));
    const age = Date.now() - Date.parse(actor.recentAuthAt);
    if (!Number.isFinite(age) || age > 15 * 60000 || age < -5000)
      throw new AppError(ErrorCode.Unauthorized, "管理存储需要重新验证邮箱");
    if (tail === "/policy" && c.req.method === "PUT") {
      const policy = StoragePolicy.strict().parse(await c.req.json());
      const result = await runner.json("/host/storage/policy", { actor, policy }, "PUT");
      await deps.store.audit("storage.policy", "updated", actor.userId);
      return c.json(result);
    }
    if (tail === "/cleanup/preview" && c.req.method === "POST") {
      z.strictObject({}).parse(await c.req.json());
      return c.json(await runner.json("/host/storage/cleanup/preview", { actor }));
    }
    if (tail === "/cleanup" && c.req.method === "POST") {
      const input = StorageCleanupInput.parse(await c.req.json());
      const result = await runner.json("/host/storage/cleanup", { actor, ...input });
      await deps.store.audit("storage.cleanup", "completed", actor.userId);
      return c.json(result);
    }
    throw new AppError(ErrorCode.NotFound, "接口不存在");
  };
  app.all("/api/v1/hosts/:hostId/storage", handle);
  app.all("/api/v1/hosts/:hostId/storage/*", handle);
}

import type { Context, Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  DeviceIdentity,
  DevicePurpose,
  RemoteId,
  type RemoteActor,
} from "@agentdesk/shared";
import type { GatewayConfig } from "../config";
import { clientAddress } from "../auth/access";
import type { GatewayStore } from "../db/store";
import type { DeviceRelay } from "./relay";

export function registerDeviceRoutes<E extends Env>(
  app: Hono<E>,
  deps: {
    config: GatewayConfig;
    store: GatewayStore;
    relay: DeviceRelay;
    peerAddress: (c: Context) => string;
    loggedIn: (c: Context) => Promise<{ actor: RemoteActor }>;
  },
) {
  const { relay, store, config } = deps,
    devices = relay.store;
  app.post("/api/v1/device-pairings", async (c) => {
    const { actor } = await deps.loggedIn(c);
    store.limit([{ key: `pair:${actor.userId}`, max: 5, windowMs: 300_000 }]);
    const result = devices.createPairing(actor);
    store.audit("device.pair", "created", actor.userId);
    return c.json(result, 201);
  });
  app.get("/api/v1/device-pairings/:id", async (c) =>
    c.json(devices.pairing((await deps.loggedIn(c)).actor, RemoteId.parse(c.req.param("id")))),
  );
  app.post("/api/v1/device-pairings/:id/confirm", async (c) => {
    const { actor } = await deps.loggedIn(c);
    const body = z
      .strictObject({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        projects: z.array(RemoteId).min(1).max(32),
      })
      .parse(await c.req.json());
    const device = devices.confirmPairing(
      actor,
      RemoteId.parse(c.req.param("id")),
      body.fingerprint,
      body.projects,
    );
    store.audit("device.pair", "confirmed", actor.userId);
    return c.json({ device });
  });
  // 在 hosts 通配路由之前注册。
  app.post("/api/v1/hosts/:hostId/revoke", async (c) => {
    const { actor } = await deps.loggedIn(c),
      id = RemoteId.parse(c.req.param("hostId"));
    devices.revoke(id, actor);
    relay.disconnect(id);
    store.audit("device.revoke", "revoked", actor.userId);
    return c.json({ revoked: true });
  });
  app.use("/device-api/*", bodyLimit({ maxSize: 32 * 1024 }));
  app.use("/device-api/*", async (c, next) => {
    const ip = clientAddress(c, config, deps.peerAddress(c));
    if (
      c.req.header("origin") ||
      c.req.header("cookie") ||
      c.req.header("content-type") !== "application/json"
    )
      throw new AppError(ErrorCode.Forbidden, "设备接口不接受浏览器会话");
    store.limit([{ key: `device-ip:${ip}`, max: 120, windowMs: 60_000 }]);
    await next();
  });
  app.post("/device-api/v1/pair", async (c) => {
    const body = z
      .strictObject({
        code: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
        identity: DeviceIdentity,
        signature: z.string().max(128),
      })
      .parse(await c.req.json());
    return c.json(devices.claim(body.code, body.identity, body.signature), 201);
  });
  app.post("/device-api/v1/challenge", async (c) => {
    const body = z
      .strictObject({ hostId: RemoteId, purpose: DevicePurpose })
      .parse(await c.req.json());
    store.limit([{ key: `device-host:${body.hostId}`, max: 40, windowMs: 60_000 }]);
    return c.json(devices.challenge(body.hostId, body.purpose));
  });
  app.post("/device-api/v1/prove", async (c) => {
    const body = z
      .strictObject({ id: z.string().uuid(), signature: z.string().max(128) })
      .parse(await c.req.json());
    const { device, purpose } = devices.authenticate(body.id, body.signature);
    if (purpose === "connect") return c.json(devices.token(device.id));
    if (purpose === "confirm") return c.json({ device: devices.localConfirm(device.id) });
    if (purpose === "revoke") {
      devices.revoke(device.id);
      relay.disconnect(device.id);
      return c.json({ revoked: true });
    }
    return c.json({ device });
  });
}

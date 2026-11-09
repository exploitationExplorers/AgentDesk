import { z } from "zod";
import { RemoteId } from "./identity";

export const DeviceProject = z.strictObject({
  id: RemoteId,
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
});
export const DeviceIdentity = z.strictObject({
  name: z.string().trim().min(1).max(128),
  platform: z.enum(["win32", "linux", "darwin"]),
  instanceId: z.string().uuid(),
  publicKey: z.string().min(32).max(256),
  projects: z.array(DeviceProject).min(1).max(32),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentity>;
export const DevicePurpose = z.enum(["status", "confirm", "connect", "revoke"]);
export type DevicePurpose = z.infer<typeof DevicePurpose>;
export function deviceProof(origin: string, hostId: string, purpose: DevicePurpose, nonce: string) {
  return JSON.stringify(["agentdesk-device-v1", origin, hostId, purpose, nonce]);
}
export function devicePairProof(origin: string, code: string, identity: DeviceIdentity) {
  return JSON.stringify(["agentdesk-pair-v1", origin, code, DeviceIdentity.parse(identity)]);
}

export const DEVICE_MAX_MESSAGE_BYTES = 256 * 1024;
export const DeviceWire = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    protocolVersion: z.literal(1),
    hostId: RemoteId,
    connectionEpoch: z.number().int().positive(),
    userId: RemoteId,
    projects: z.array(RemoteId).min(1).max(32),
  }),
  z.strictObject({ type: z.literal("heartbeat") }),
  z.strictObject({
    type: z.literal("request"),
    id: z.string().uuid(),
    path: z.string().max(256),
    method: z.enum(["GET", "POST", "PUT"]),
    body: z.unknown().optional(),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal("response"),
    id: z.string().uuid(),
    status: z.number().int().min(200).max(599),
    stream: z.boolean(),
    body: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal("chunk"), id: z.string().uuid(), data: z.string().max(88_000) }),
  z.strictObject({ type: z.literal("end"), id: z.string().uuid() }),
  z.strictObject({ type: z.literal("pull"), id: z.string().uuid() }),
  z.strictObject({ type: z.literal("cancel"), id: z.string().uuid() }),
]);
export type DeviceWire = z.infer<typeof DeviceWire>;

/** 固定 RPC 白名单，绝不把连接器当成通用 HTTP/内网代理。 */
export function allowedDeviceRoute(method: string, path: string): boolean {
  if (method === "GET")
    return ["/health", "/host", "/host/projects", "/host/providers"].includes(path);
  if (method === "PUT")
    return (
      path === "/grants" || /^\/host\/(providers\/[A-Za-z0-9_.:-]+|provider-bindings)$/.test(path)
    );
  return (
    method === "POST" &&
    (path === "/commands" ||
      /^\/host\/executors\/codex\/(login|login-status)$/.test(path) ||
      path === "/operations/lookup" ||
      /^\/(operations\/[A-Za-z0-9_.:-]+|tasks\/[A-Za-z0-9_.:-]+\/(lease|events)|host\/providers\/[A-Za-z0-9_.:-]+\/test)$/.test(
        path,
      ))
  );
}

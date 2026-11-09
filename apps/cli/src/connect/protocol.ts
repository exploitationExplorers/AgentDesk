import { createPrivateKey, sign } from "node:crypto";
import { deviceProof, type DevicePurpose } from "@agentdesk/shared";
import type { ConnectorCredentials } from "./credentials.js";

export async function devicePost<T>(server: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${server}/device-api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`设备验证失败（HTTP ${response.status}），请检查配对状态和服务器地址。`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("设备服务响应过大。");
  return JSON.parse(text) as T;
}
export function signDevice(privateKey: string, message: string) {
  return sign(
    null,
    Buffer.from(message),
    createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }),
  ).toString("base64");
}
export async function proveDevice<T>(
  credentials: ConnectorCredentials,
  purpose: DevicePurpose,
): Promise<T> {
  const { id, nonce } = await devicePost<{ id: string; nonce: string }>(
    credentials.server,
    "/challenge",
    { hostId: credentials.hostId, purpose },
  );
  return devicePost<T>(credentials.server, "/prove", {
    id,
    signature: signDevice(
      credentials.privateKey,
      deviceProof(credentials.server, credentials.hostId, purpose, nonce),
    ),
  });
}

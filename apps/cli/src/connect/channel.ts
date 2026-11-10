import {
  allowedDeviceRoute,
  DEVICE_MAX_MESSAGE_BYTES,
  DeviceWire,
  ProjectGrant,
  RemoteCommand,
} from "@agentdesk/shared";
import type { ConnectorCredentials } from "./credentials.js";
import { proveDevice } from "./protocol.js";

export interface ConnectorStatus {
  state: "connecting" | "online" | "offline" | "stopped";
  lastConnectedAt?: string;
  hostId: string;
  server: string;
}
export function startConnector(
  credentials: ConnectorCredentials,
  handle: (request: Request) => Promise<Response> | Response,
  authenticateLocal: (request: Request) => Request,
  transport = {
    authorize: () => proveDevice<{ token: string }>(credentials, "connect"),
    open: (token: string) =>
      new WebSocket(credentials.server.replace(/^https:/, "wss:") + "/device-channel", [
        "agentdesk-v1",
        token,
      ]),
  },
) {
  const status: ConnectorStatus = {
    state: "connecting",
    hostId: credentials.hostId,
    server: credentials.server,
  };
  let stopped = false,
    ws: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempt = 0,
    epoch = 0,
    lastHeartbeat = 0;
  const readers = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
  const busy = new Set<string>();
  // Node undici rejects close() without a valid code and throws if the socket is already closing.
  const closeSocket = (socket: WebSocket, code = 1000, reason?: string) => {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(code, reason);
    } catch {
      /* ignore */
    }
  };
  const send = (message: DeviceWire) => {
    const text = JSON.stringify(message);
    if (
      Buffer.byteLength(text) > DEVICE_MAX_MESSAGE_BYTES ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      ws.bufferedAmount > 1024 * 1024
    )
      throw new Error("Device channel unavailable");
    ws.send(text);
  };
  const cleanup = () => {
    clearInterval(heartbeat);
    for (const reader of readers.values()) void reader.cancel().catch(() => undefined);
    readers.clear();
  };
  const schedule = () => {
    if (stopped) return;
    status.state = "offline";
    clearTimeout(retry);
    retry = setTimeout(
      () => void connect(),
      Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.floor(Math.random() * 500),
    );
    retry.unref();
  };
  const dispatch = async (message: Extract<DeviceWire, { type: "request" }>, socket: WebSocket) => {
    if (
      !epoch ||
      busy.size >= 16 ||
      busy.has(message.id) ||
      !allowedDeviceRoute(message.method, message.path) ||
      Date.parse(message.expiresAt) <= Date.now() ||
      Date.parse(message.expiresAt) > Date.now() + 35_000
    )
      throw new Error("Invalid command");
    const body = message.body as { command?: unknown } | undefined;
    if (message.path === "/grants" || body?.command) {
      const envelope =
        message.path === "/grants" ? ProjectGrant.parse(body) : RemoteCommand.parse(body!.command);
      if (
        envelope.hostId !== credentials.hostId ||
        envelope.userId !== credentials.userId ||
        envelope.connectionEpoch !== epoch ||
        !credentials.projects.includes(envelope.projectId) ||
        envelope.workspaceId !== envelope.projectId ||
        Date.parse(envelope.expiresAt) > Date.now() + 45_000
      )
        throw new Error("Unauthorized device command");
    }
    busy.add(message.id);
    try {
      const request = new Request(`http://connector/remote-api/v1${message.path}`, {
        method: message.method,
        headers: { "content-type": "application/json" },
        ...(message.body === undefined ? {} : { body: JSON.stringify(message.body) }),
      });
      const response = await handle(authenticateLocal(request));
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
        void response.body?.cancel();
        return;
      }
      if (
        response.headers.get("content-type")?.includes("text/event-stream") &&
        response.ok &&
        response.body
      ) {
        readers.set(message.id, response.body.getReader());
        send({ type: "response", id: message.id, status: response.status, stream: true });
      } else {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (reader)
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              length += next.value.length;
              if (length > 180_000) throw new Error("Device response exceeds limit");
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        send({
          type: "response",
          id: message.id,
          status: response.status,
          stream: false,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
        });
      }
    } catch {
      if (ws === socket && socket.readyState === WebSocket.OPEN)
        send({
          type: "response",
          id: message.id,
          status: 503,
          stream: false,
          body: {
            error: { code: "SERVICE_UNAVAILABLE", message: "设备执行暂时不可用，请查询原操作状态" },
          },
        });
    } finally {
      busy.delete(message.id);
    }
  };
  const connect = async () => {
    if (stopped) return;
    status.state = "connecting";
    try {
      const { token } = await transport.authorize();
      if (stopped) return;
      const socket = transport.open(token);
      ws = socket;
      epoch = 0;
      const opening = setTimeout(() => closeSocket(socket, 1000), 15_000);
      opening.unref();
      socket.addEventListener("message", (event) => {
        void (async () => {
          if (
            typeof event.data !== "string" ||
            Buffer.byteLength(event.data) > DEVICE_MAX_MESSAGE_BYTES
          )
            throw new Error("Invalid device message");
          const message = DeviceWire.parse(JSON.parse(event.data));
          if (message.type === "hello") {
            if (
              epoch ||
              message.hostId !== credentials.hostId ||
              message.userId !== credentials.userId ||
              message.projects.length !== credentials.projects.length ||
              message.projects.some((p) => !credentials.projects.includes(p))
            )
              throw new Error("Device identity changed");
            epoch = message.connectionEpoch;
            clearTimeout(opening);
            attempt = 0;
            lastHeartbeat = Date.now();
            status.state = "online";
            status.lastConnectedAt = new Date().toISOString();
            send({ type: "heartbeat" });
            heartbeat = setInterval(() => {
              if (Date.now() - lastHeartbeat >= 45_000) closeSocket(socket, 1000);
              else
                try {
                  send({ type: "heartbeat" });
                } catch {
                  closeSocket(socket, 1000);
                }
            }, 15_000);
            heartbeat.unref();
            return;
          }
          if (message.type === "heartbeat") {
            lastHeartbeat = Date.now();
            return;
          }
          if (message.type === "request") {
            await dispatch(message, socket);
            return;
          }
          if (message.type === "cancel") {
            const reader = readers.get(message.id);
            readers.delete(message.id);
            await reader?.cancel();
            return;
          }
          if (message.type === "pull") {
            const reader = readers.get(message.id);
            if (!reader) return;
            if (busy.has(message.id)) throw new Error("Duplicate stream read");
            busy.add(message.id);
            try {
              const result = await reader.read();
              if (ws !== socket || !readers.has(message.id)) return;
              if (result.done) {
                readers.delete(message.id);
                send({ type: "end", id: message.id });
              } else {
                if (result.value.byteLength > 64 * 1024)
                  throw new Error("Event chunk exceeds limit");
                send({
                  type: "chunk",
                  id: message.id,
                  data: Buffer.from(result.value).toString("base64"),
                });
              }
            } finally {
              busy.delete(message.id);
            }
            return;
          }
          throw new Error("Unexpected device message");
        })().catch(() => closeSocket(socket, 1008, "Invalid protocol"));
      });
      socket.addEventListener("close", () => {
        clearTimeout(opening);
        cleanup();
        if (ws === socket) {
          ws = undefined;
          schedule();
        }
      });
      socket.addEventListener("error", () => closeSocket(socket, 1011));
    } catch {
      schedule();
    }
  };
  void connect();
  return {
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      cleanup();
      if (ws) closeSocket(ws, 1000);
      status.state = "stopped";
    },
  };
}

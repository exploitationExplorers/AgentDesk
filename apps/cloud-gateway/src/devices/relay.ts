import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import {
  AppError,
  ErrorCode,
  allowedDeviceRoute,
  DeviceWire,
  DEVICE_MAX_MESSAGE_BYTES,
} from "@agentdesk/shared";
import { clientAddress } from "../auth/access";
import type { GatewayConfig } from "../config";
import type { DeviceRecord, DeviceStore } from "./store";

interface Pending {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  timer?: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  answered: boolean;
}
interface Connection {
  ws: WebSocket;
  device: DeviceRecord;
  seen: number;
  pending: Map<string, Pending>;
}

/** 有界的请求/响应中继；写请求只投递当前 epoch，不在断线后补发。 */
export class DeviceRelay {
  private readonly connections = new Map<string, Connection>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(readonly store: DeviceStore) {
    this.timer = setInterval(() => {
      for (const connection of this.connections.values())
        if (Date.now() - connection.seen >= 45_000) connection.ws.terminate();
    }, 5000);
    this.timer.unref();
  }
  online(hostId: string) {
    const entry = this.connections.get(hostId);
    return (
      !!entry &&
      entry.ws.readyState === WebSocket.OPEN &&
      Date.now() - entry.seen < 45_000 &&
      this.store.get(hostId).state === "active"
    );
  }
  epoch(hostId: string) {
    if (!this.online(hostId)) throw new AppError(ErrorCode.HostOffline, "电脑离线，请上线后重试");
    return this.connections.get(hostId)!.device.epoch;
  }
  disconnect(hostId: string) {
    this.connections.get(hostId)?.ws.close(4001, "Device revoked");
  }
  close() {
    clearInterval(this.timer);
    for (const entry of this.connections.values()) entry.ws.terminate();
  }
  attach(ws: WebSocket, device: DeviceRecord) {
    this.connections.get(device.id)?.ws.terminate();
    const entry: Connection = { ws, device, seen: Date.now(), pending: new Map() };
    this.connections.set(device.id, entry);
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      if (this.connections.get(device.id) === entry) this.connections.delete(device.id);
      for (const item of entry.pending.values()) {
        clearTimeout(item.timer);
        item.cleanup();
        const error = new AppError(ErrorCode.HostOffline, "连接中断，请核对原操作结果");
        if (item.controller) item.controller.error(error);
        else item.reject(error);
      }
      entry.pending.clear();
    });
    let count = 0,
      window = Date.now();
    ws.on("message", (data, binary) => {
      try {
        if (Date.now() - window >= 1000) {
          window = Date.now();
          count = 0;
        }
        if (
          ++count > 128 ||
          binary ||
          !Buffer.isBuffer(data) ||
          data.byteLength > DEVICE_MAX_MESSAGE_BYTES ||
          this.connections.get(device.id) !== entry
        )
          throw new Error("Invalid device message");
        const message = DeviceWire.parse(JSON.parse(data.toString()));
        if (message.type === "heartbeat") {
          if (!this.store.heartbeat(device.id, device.epoch)) throw new Error("Stale device");
          entry.seen = Date.now();
          this.send(entry, { type: "heartbeat" });
          return;
        }
        if (!["response", "chunk", "end"].includes(message.type))
          throw new Error("Unexpected device message");
        if (!("id" in message)) return;
        const item = entry.pending.get(message.id);
        if (!item) return;
        if (message.type === "response") {
          if (item.answered) throw new Error("Duplicate response");
          item.answered = true;
          clearTimeout(item.timer);
          if (message.stream) {
            if (message.status !== 200) throw new Error("Invalid stream response");
            const id = message.id;
            const stream = new ReadableStream<Uint8Array>(
              {
                start: (controller) => {
                  item.controller = controller;
                },
                pull: () => {
                  this.send(entry, { type: "pull", id });
                },
                cancel: () => {
                  item.cleanup();
                  entry.pending.delete(id);
                  this.send(entry, { type: "cancel", id });
                },
              },
              { highWaterMark: 0 },
            );
            item.resolve(
              new Response(stream, { headers: { "content-type": "text/event-stream" } }),
            );
          } else {
            item.cleanup();
            entry.pending.delete(message.id);
            item.resolve(
              new Response(JSON.stringify(message.body ?? null), {
                status: message.status,
                headers: { "content-type": "application/json" },
              }),
            );
          }
        } else if (message.type === "chunk") {
          if (!item.controller) throw new Error("Unexpected stream chunk");
          // 每次 pull 只读取一块；对多发消息的设备立即关闭，防止内存队列无界增长。
          if ((item.controller.desiredSize ?? 0) < 0) throw new Error("Stream overflow");
          item.controller.enqueue(Buffer.from(message.data, "base64"));
        } else if (message.type === "end") {
          if (!item.controller) throw new Error("Unexpected stream end");
          item.controller.close();
          item.cleanup();
          entry.pending.delete(message.id);
        }
      } catch {
        ws.close(1008, "Invalid device protocol");
      }
    });
    this.send(entry, {
      type: "hello",
      protocolVersion: 1,
      hostId: device.id,
      connectionEpoch: device.epoch,
      userId: device.userId,
      projects: device.projects,
    });
  }
  async request(
    hostId: string,
    path: string,
    body?: unknown,
    options: { method?: string; signal?: AbortSignal; stream?: boolean } = {},
  ) {
    this.epoch(hostId);
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    if (!allowedDeviceRoute(method, path))
      throw new AppError(ErrorCode.Forbidden, "设备接口未授权");
    const entry = this.connections.get(hostId)!;
    if (entry.pending.size >= 16)
      throw new AppError(ErrorCode.RateLimited, "设备请求过多，请稍后重试");
    options.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        const item = entry.pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        item.cleanup();
        entry.pending.delete(id);
        this.send(entry, { type: "cancel", id });
        const error = new AppError(ErrorCode.HostOffline, "请求已中断，请查询原操作状态");
        if (item.controller) item.controller.error(error);
        else reject(error);
      };
      const timer = setTimeout(abort, 30_000);
      timer.unref();
      entry.pending.set(id, {
        resolve,
        reject,
        timer,
        answered: false,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send(entry, {
          type: "request",
          id,
          path,
          method: method as "GET" | "POST" | "PUT",
          body,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
      } catch (error) {
        clearTimeout(timer);
        entry.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        reject(error as Error);
      }
    });
  }
  private send(entry: Connection, value: DeviceWire) {
    const data = JSON.stringify(value);
    if (
      Buffer.byteLength(data) > DEVICE_MAX_MESSAGE_BYTES ||
      entry.ws.bufferedAmount > DEVICE_MAX_MESSAGE_BYTES * 4
    ) {
      entry.ws.terminate();
      throw new AppError(ErrorCode.ServiceUnavailable, "设备消息超过限制");
    }
    entry.ws.send(data);
  }
}

export function attachDeviceChannel(server: Server, config: GatewayConfig, relay: DeviceRelay) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: DEVICE_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("agentdesk-v1") ? "agentdesk-v1" : false),
  });
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      if (request.url !== "/device-channel" || request.headers.origin || request.headers.cookie)
        throw new Error();
      // 与 HTTP 共用域名、TLS 与代理校验，令牌不出现在 URL/访问日志中。
      const validation = new Hono();
      validation.get("/device-channel", (c) => {
        clientAddress(c, config, request.socket.remoteAddress ?? "unknown");
        return c.text("ok");
      });
      validation.onError((_error, c) => c.text("Invalid transport", 403));
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(key, value);
      if (!(await validation.request("http://gateway/device-channel", { headers })).ok)
        throw new Error();
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((p) => p.trim());
      if (
        protocols.length !== 2 ||
        protocols[0] !== "agentdesk-v1" ||
        !/^[A-Za-z0-9_-]{43}$/.test(protocols[1]!)
      )
        throw new Error();
      const device = relay.store.consumeToken(protocols[1]!);
      wss.handleUpgrade(request, socket, head, (ws) => relay.attach(ws, device));
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  };
  server.on("upgrade", upgrade);
  return () => {
    server.off("upgrade", upgrade);
    relay.close();
    wss.close();
  };
}

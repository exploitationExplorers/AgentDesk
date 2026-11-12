import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import nodemailer from "nodemailer";
import { loadGatewayConfig } from "./config";
import { GatewayStore } from "./db/store";
import { createPostgresDatabase, gatewayDatabase } from "./db/database";
import { createGatewayAuth } from "./auth/service";
import { createGatewayApp } from "./app";
import { HostRunnerClient } from "./devices/client";
import { DeviceStore } from "./devices/store";
import { DeviceRelay, attachDeviceChannel } from "./devices/relay";
import type { Server } from "node:http";
import { RemoteGatewayService } from "./remote/service";
import { GatewayTransfers } from "./remote/transfers";
import { RemoteRoutingStore } from "./remote/store";

const config = loadGatewayConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const db = config.databaseUrl
  ? await createPostgresDatabase(config.databaseUrl, config.databaseSchema)
  : (() => {
      const raw = new Database(join(config.dataDir, "gateway.db"));
      raw.pragma("journal_mode=WAL");
      raw.pragma("foreign_keys=ON");
      raw.pragma("busy_timeout=5000");
      return gatewayDatabase(raw);
    })();
const smtp = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  requireTLS: !config.smtp.secure,
  auth: { user: config.smtp.user, pass: config.smtp.password },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  disableFileAccess: true,
  disableUrlAccess: true,
});
const store = new GatewayStore(db, config.otpPepper);
const routing = new RemoteRoutingStore(db);
const devices = new DeviceRelay(new DeviceStore(db, config.otpPepper, config.publicOrigin));
const runner = new HostRunnerClient(config, devices);
const remote = new RemoteGatewayService(runner, routing);
const transfers = new GatewayTransfers(db, remote, routing);
await Promise.all([store.ready, routing.ready, devices.store.ready, transfers.ready]);
const auth = await createGatewayAuth(config, db, async (email, otp) => {
  await smtp.sendMail({
    from: config.smtp.from,
    to: email,
    subject: "AgentDesk 登录验证码",
    text: `你的登录验证码是 ${otp}，5 分钟内有效。请勿将验证码提供给他人。`,
  });
});
const shutdown = new AbortController();
const app = createGatewayApp({
  shutdownSignal: shutdown.signal,
  config,
  auth,
  store,
  runner,
  remote,
  routing,
  devices,
  transfers,
  staticDir: process.env.GATEWAY_STATIC_DIR
    ? resolve(process.env.GATEWAY_STATIC_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), "public"),
  peerAddress: (c) => getConnInfo(c).remote.address ?? "unknown",
});
remote.start();
await transfers.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
const closeDevices = attachDeviceChannel(server as Server, config, devices);
console.info(`[gateway] listening on ${config.host}:${config.port}`);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  closeDevices();
  const drained = Promise.all([transfers.stop(), remote.stop()]);
  server.close(() => {
    void drained.then(async () => {
      smtp.close();
      await db.close();
    });
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

import { readFileSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { openDatabase } from "./db/client";
import { TeamService } from "./services/team";
import { createTeamApp } from "./team-app";

const keyFile = process.env.TEAM_ADMIN_KEY_FILE;
if (!keyFile) throw new Error("TEAM_ADMIN_KEY_FILE is required");
if (process.platform !== "win32" && statSync(keyFile).mode & 0o077)
  throw new Error("Team admin key file must be readable only by its owner");
const adminKey = readFileSync(keyFile, "utf8").trim();
if (adminKey.length < 32) throw new Error("Team admin key must contain at least 32 characters");
const dataDir = resolve(process.env.TEAM_DATA_DIR ?? ".team-data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const database = openDatabase(dataDir);
const publicOrigin = process.env.TEAM_PUBLIC_ORIGIN;
if (publicOrigin) {
  const url = new URL(publicOrigin);
  if (url.protocol !== "https:" || url.origin !== publicOrigin)
    throw new Error("TEAM_PUBLIC_ORIGIN must be an HTTPS origin");
} else if (process.env.NODE_ENV === "production")
  throw new Error("TEAM_PUBLIC_ORIGIN is required in production");
const app = createTeamApp(new TeamService(database.db), {
  adminKey,
  publicOrigin,
  webRoot: process.env.TEAM_WEB_ROOT ? resolve(process.env.TEAM_WEB_ROOT) : undefined,
});
const port = Number(process.env.TEAM_PORT ?? 17895);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TEAM_PORT");
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.info(`[team] listening on 127.0.0.1:${port}`);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    database.close();
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

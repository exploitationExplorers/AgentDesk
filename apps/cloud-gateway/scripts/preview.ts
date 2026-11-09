import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { registerCloudAssets } from "../src/static";

// 浏览器验收使用实际 Gateway 静态路由及 CSP；API 由 Playwright 的显式 fixtures 提供。
const app = new Hono();
registerCloudAssets(app, resolve("dist/public"));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 1442 });
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());

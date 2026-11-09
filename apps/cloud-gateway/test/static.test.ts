import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerCloudAssets } from "../src/static";

let root: string;
let app: Hono;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentdesk-public-"));
  await mkdir(join(root, "assets"));
  await Promise.all([
    writeFile(join(root, "cloud.html"), "<!doctype html><title>AgentDesk</title>"),
    writeFile(join(root, "cloud-sw.js"), "/* public worker */"),
    writeFile(join(root, "assets", "cloud-a1b2.js"), "/* public bundle */"),
    writeFile(join(root, "private.key"), "must never be served"),
    writeFile(join(root, "assets", "cloud-a1b2.js.map"), "private source map"),
  ]);
  app = new Hono();
  app.get("/api/v1/session", (c) => c.json({ error: "unauthorized" }, 401));
  registerCloudAssets(app, root);
});
afterEach(async () => rm(root, { force: true, recursive: true }));

it("serves the public entry and worker while keeping API errors and private paths distinct", async () => {
  const page = await app.request("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(page.headers.get("cache-control")).toBe("no-cache");
  const script = await app.request("/assets/cloud-a1b2.js");
  expect(await script.text()).toBe("/* public bundle */");
  expect(script.headers.get("cache-control")).toContain("immutable");
  expect((await app.request("/cloud-sw.js")).headers.get("service-worker-allowed")).toBe("/");
  expect(await (await app.request("/cloud.html", { method: "HEAD" })).text()).toBe("");
  expect((await app.request("/api/v1/session")).status).toBe(401);
  for (const path of [
    "/api/unknown",
    "/private.key",
    "/assets/cloud-a1b2.js.map",
    "/%2e%2e/private.key",
    "/cloud.html?token=secret",
    "/unknown",
  ])
    expect((await app.request(path)).status, path).toBe(404);
  expect((await app.request("/cloud.html", { method: "POST" })).status).toBe(404);
});

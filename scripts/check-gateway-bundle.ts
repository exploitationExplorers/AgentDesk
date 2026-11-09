import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 使用隔离的临时身份库和随机测试密钥；只验证构建入口，不投递邮件或连接 Runner。
const directory = mkdtempSync(join(tmpdir(), "agentdesk-gateway-smoke-"));
const key = join(directory, "test-key");
writeFileSync(key, randomBytes(32).toString("hex"), { mode: 0o600 });
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const child = spawn(
  process.execPath,
  [process.env.GATEWAY_SMOKE_ENTRY ?? resolve("apps/cloud-gateway/dist/server.mjs")],
  {
    env: {
      ...process.env,
      PUBLIC_ORIGIN: "https://gateway.example.test",
      OWNER_EMAIL: "owner@example.test",
      GATEWAY_DATA_DIR: directory,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(port),
      SESSION_SECRET_FILE: key,
      OTP_PEPPER_FILE: key,
      REMOTE_SHARED_TOKEN_FILE: key,
      CLOUD_RUNNER_URL: "http://127.0.0.1:1",
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1",
      SMTP_SECURE: "true",
      SMTP_USER: "test",
      SMTP_PASSWORD_FILE: key,
      SMTP_FROM: "owner@example.test",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
child.stdout.on("data", (data: Buffer) => {
  output = (output + data.toString()).slice(-4000);
});
child.stderr.on("data", (data: Buffer) => {
  output = (output + data.toString()).slice(-4000);
});
const exited = new Promise<void>((resolve, reject) => {
  child.once("exit", () => resolve());
  child.once("error", reject);
});
// Node fetch 会重写 Host；用 HTTP 客户端模拟 Nginx 保留公开 Host 的实际转发。
function fetchLocal(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: "127.0.0.1", port, path, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        resolve(
          new Response(Buffer.concat(chunks), {
            status: incoming.statusCode,
            headers: responseHeaders,
          }),
        );
      });
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Gateway smoke request timed out")));
  });
}
try {
  const deadline = Date.now() + 15_000;
  while (!output.includes("[gateway] listening")) {
    if (child.exitCode !== null || Date.now() >= deadline)
      throw new Error(`Gateway startup failed: ${output}`);
    await delay(50);
  }
  assert.equal((await fetchLocal("/health/live")).status, 200);
  const page = await fetchLocal("/");
  assert.equal(page.status, 200);
  const markup = await page.text();
  const asset = markup.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, "Gateway must serve the built mobile entry");
  assert.equal((await fetchLocal(asset)).status, 200);
  assert.equal((await fetchLocal("/cloud-sw.js")).headers.get("service-worker-allowed"), "/");
  assert.equal((await fetchLocal("/server.mjs")).status, 404);
  assert.equal((await fetchLocal("/api/v1/session")).status, 403);
  const headers = {
    host: "gateway.example.test",
    "x-forwarded-proto": "https",
    "x-forwarded-for": "192.0.2.1",
  };
  const session = await fetchLocal("/api/v1/session", headers);
  assert.equal(session.status, 401, await session.text());
  assert.equal((await fetchLocal("/internal-auth/get-session", headers)).status, 404);
  const csrf = await fetchLocal("/api/v1/auth/csrf", headers);
  assert.equal(csrf.status, 200);
  assert.equal(csrf.headers.get("cache-control"), "no-store");
  assert.ok(csrf.headers.getSetCookie()[0]?.includes("Secure"));
  console.info(
    "Gateway bundle smoke passed: startup, native database, no anonymous session, HTTPS/proxy boundary, private auth routes, CSRF cookie.",
  );
} finally {
  child.kill();
  await exited;
  rmSync(directory, { recursive: true, force: true });
}

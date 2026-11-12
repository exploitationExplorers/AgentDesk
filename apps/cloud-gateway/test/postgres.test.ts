import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devicePairProof, type DeviceIdentity } from "@agentdesk/shared";
import { createPostgresDatabase, type GatewayDatabase } from "../src/db/database";
import { GatewayStore } from "../src/db/store";
import { DeviceStore } from "../src/devices/store";
import { RemoteRoutingStore } from "../src/remote/store";
import { createGatewayAuth } from "../src/auth/service";
import { createGatewayApp } from "../src/app";
import { parseTrustedProxies, type GatewayConfig } from "../src/config";
import { RunnerClient } from "../src/remote/client";
import { RemoteGatewayService } from "../src/remote/service";
import Database from "better-sqlite3";
import { migrateGateway } from "../src/db/migrate";
import { GatewayTransfers } from "../src/remote/transfers";

// 必须显式指定隔离测试库；每轮只操作唯一 schema，不触碰已有业务表。
const urlFile = process.env.GATEWAY_TEST_DATABASE_URL_FILE;
describe.skipIf(!urlFile)("real PostgreSQL persistence", () => {
  let db: GatewayDatabase;
  let store: GatewayStore;
  let routing: RemoteRoutingStore;
  let devices: DeviceStore;
  let app: ReturnType<typeof createGatewayApp>;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const email = "owner@example.test";
  const origin = "https://agent.example.test";
  let otp = "";
  let loginHeaders: Record<string, string>;
  beforeAll(async () => {
    db = await createPostgresDatabase(readFileSync(urlFile!, "utf8").trim(), schema);
    store = new GatewayStore(db, "p".repeat(32));
    routing = new RemoteRoutingStore(db);
    devices = new DeviceStore(db, "p".repeat(32), origin);
    await Promise.all([store.ready, routing.ready, devices.ready]);
    const config = {
      publicOrigin: origin,
      ownerEmail: email,
      authMultiUser: false,
      sessionSecret: randomBytes(32).toString("hex"),
      otpPepper: "p".repeat(32),
      runnerUrl: "http://runner:17893",
      remoteToken: "r".repeat(32),
      trustedProxies: parseTrustedProxies("127.0.0.1/32"),
    } as GatewayConfig;
    const auth = await createGatewayAuth(config, db, async (_email, value) => {
      otp = value;
    });
    const runner = new RunnerClient(config, async () => Response.json({}));
    app = createGatewayApp({
      config,
      auth,
      store,
      routing,
      runner,
      remote: new RemoteGatewayService(runner, routing),
      peerAddress: () => "127.0.0.1",
    });
    const csrf = await app.request(`${origin}/api/v1/auth/csrf`, {
      headers: { host: "agent.example.test" },
    });
    loginHeaders = {
      cookie: csrf.headers.getSetCookie()[0]!.split(";")[0]!,
      "x-csrf-token": (await csrf.json()).csrfToken,
    };
  }, 30000);
  afterAll(async () => {
    if (db) {
      await db.exec(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
  function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(`${origin}/api/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: "agent.example.test",
        origin,
        "content-type": "application/json",
        ...(path.startsWith("auth/") ? loginHeaders : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  it("preserves OTP single use, hashed sessions, CSRF, expiry and revocation", async () => {
    expect((await request("auth/otp/request", { email })).status).toBe(202);
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () => request("auth/otp/verify", { email, otp })),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    const cookie = attempts
      .find((r) => r.ok)!
      .headers.getSetCookie()
      .find((c) => c.startsWith("__Host-agentdesk_session="))!
      .split(";")[0]!;
    const row = (await db.prepare('SELECT token FROM "session"').get()) as { token: string };
    expect(row.token).toMatch(/^[a-f0-9]{64}$/);
    expect(decodeURIComponent(cookie)).not.toContain(row.token);
    const session = await (await request("session", undefined, { cookie })).json();
    expect(session.user.email).toBe(email);
    const actor = {
      userId: session.user.id,
      sessionId: session.session.id,
      recentAuthAt: new Date().toISOString(),
    };
    expect(await routing.sessionAlive(actor)).toBe(true);
    expect((await request("logout", {}, { cookie })).status).toBe(403);
    expect(
      (await request("logout", {}, { cookie, "x-csrf-token": session.csrfToken })).status,
    ).toBe(200);
    expect(await routing.sessionAlive(actor)).toBe(false);
  });
  it("rolls back complete async transactions and enforces concurrent rate limits", async () => {
    await expect(
      db.transaction(async () => {
        await store.audit("rollback-probe", "created");
        await Promise.resolve();
        throw new Error("rollback");
      })(),
    ).rejects.toThrow("rollback");
    expect(
      await db.prepare("SELECT 1 FROM gateway_audit WHERE action='rollback-probe'").get(),
    ).toBeUndefined();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        store.limit([{ key: "concurrent", max: 2, windowMs: 60000 }]),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
  it("consumes pairing and connection tokens once across concurrent transactions", async () => {
    const actor = { userId: "owner", sessionId: "session", recentAuthAt: new Date().toISOString() };
    const pair = await devices.createPairing(actor);
    const keys = generateKeyPairSync("ed25519");
    const identity: DeviceIdentity = {
      name: "test",
      platform: "linux",
      instanceId: randomUUID(),
      publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      projects: [{ id: "p", name: "p", path: "/workspace" }],
    };
    const proof = sign(
      null,
      Buffer.from(devicePairProof(origin, pair.code, identity)),
      keys.privateKey,
    ).toString("base64");
    const claims = await Promise.allSettled([
      devices.claim(pair.code, identity, proof),
      devices.claim(pair.code, identity, proof),
    ]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const claim = (
      claims.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<DeviceStore["claim"]>>
      >
    ).value;
    await devices.confirmPairing(actor, pair.id, claim.fingerprint, ["p"]);
    await devices.localConfirm(claim.hostId);
    const token = await devices.token(claim.hostId);
    const consumed = await Promise.allSettled([
      devices.consumeToken(token.token),
      devices.consumeToken(token.token),
    ]);
    expect(consumed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await devices.revoke(claim.hostId, actor);
    await expect(devices.token(claim.hostId)).rejects.toThrow();
  });
  if (process.env.GATEWAY_TEST_SQLITE_BACKUP)
    it("reconciles every production backup table and refuses a second import", async () => {
      const migrationSchema = `${schema}_m`;
      const target = await createPostgresDatabase(
        readFileSync(urlFile!, "utf8").trim(),
        migrationSchema,
      );
      const source = new Database(process.env.GATEWAY_TEST_SQLITE_BACKUP!, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const migratedStore = new GatewayStore(target, "p".repeat(32));
        const migratedRouting = new RemoteRoutingStore(target);
        const migratedDevices = new DeviceStore(target, "p".repeat(32), origin);
        const config = {
          publicOrigin: origin,
          ownerEmail: email,
          authMultiUser: true,
          sessionSecret: "s".repeat(32),
          otpPepper: "p".repeat(32),
        } as GatewayConfig;
        const remote = new RemoteGatewayService(
          new RunnerClient({ runnerUrl: "http://runner:17893", remoteToken: "r".repeat(32) }),
          migratedRouting,
        );
        const transfers = new GatewayTransfers(target, remote, migratedRouting);
        await Promise.all([
          migratedStore.ready,
          migratedRouting.ready,
          migratedDevices.ready,
          transfers.ready,
        ]);
        await createGatewayAuth(config, target, async () => {}, { initializeOwner: false });
        const result = await migrateGateway(source, target);
        expect(result.verified).toBe(true);
        expect(result.tables).toHaveLength(14);
        await expect(migrateGateway(source, target)).rejects.toThrow("not empty");
        // 失败的重复导入必须完整回滚，既有导入结果保持可读。
        const migrated = (await target.prepare('SELECT count(*) AS n FROM "session"').get()) as {
          n: number;
        };
        expect(migrated.n).toBe(result.tables.find((row) => row.table === "session")!.rows);
      } finally {
        source.close();
        await target.exec(`DROP SCHEMA "${migrationSchema}" CASCADE`);
        await target.close();
      }
    });
});

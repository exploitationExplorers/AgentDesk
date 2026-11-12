import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import type Database from "better-sqlite3";
import { gatewayDatabase, type GatewayDatabase } from "../db/database";
import {
  AppError,
  ErrorCode,
  DeviceIdentity,
  type DevicePurpose,
  devicePairProof,
  deviceProof,
  type RemoteActor,
} from "@agentdesk/shared";
export interface DeviceRecord {
  id: string;
  userId: string;
  identity: DeviceIdentity;
  fingerprint: string;
  projects: string[];
  state: "pending" | "confirmed" | "active" | "revoked";
  epoch: number;
  lastSeen: number | null;
}
interface PairRow {
  id: string;
  user_id: string;
  expires: number;
  host_id: string | null;
}
interface DeviceRow {
  id: string;
  user_id: string;
  identity: string;
  fingerprint: string;
  projects: string;
  state: DeviceRecord["state"];
  epoch: number;
  last_seen: number | null;
}
export class DeviceStore {
  readonly db: GatewayDatabase;
  readonly ready: Promise<void>;
  constructor(
    database: Database.Database | GatewayDatabase,
    private readonly pepper: string,
    readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = gatewayDatabase(database);
    this.ready = this.initialize();
  }
  private async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_pairings (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,
        code_hash TEXT UNIQUE NOT NULL,expires BIGINT NOT NULL,host_id TEXT);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,identity TEXT NOT NULL,
        fingerprint TEXT NOT NULL,projects TEXT NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,last_seen BIGINT);
      CREATE TABLE IF NOT EXISTS device_challenges (id TEXT PRIMARY KEY,host_id TEXT NOT NULL,purpose TEXT NOT NULL,
        nonce TEXT NOT NULL,expires BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_tokens (hash TEXT PRIMARY KEY,host_id TEXT NOT NULL,expires BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS device_owner ON devices(user_id,state);
    `);
  }
  private hash(value: string) {
    return createHmac("sha256", this.pepper).update(value).digest("hex");
  }
  private recent(actor: RemoteActor) {
    const age = this.now() - Date.parse(actor.recentAuthAt);
    if (!Number.isFinite(age) || age < -5000 || age > 900000)
      throw new AppError(ErrorCode.Unauthorized, "配对和撤销需要重新验证邮箱");
  }
  async createPairing(actor: RemoteActor) {
    await this.ready;
    this.recent(actor);
    await this.prune();
    const code = randomBytes(18).toString("base64url");
    const id = randomUUID(),
      expiresAt = this.now() + 300000;
    await this.db
      .prepare("INSERT INTO device_pairings(id,user_id,code_hash,expires) VALUES(?,?,?,?)")
      .run(id, actor.userId, this.hash(code), expiresAt);
    return { id, code, expiresAt: new Date(expiresAt).toISOString() };
  }
  async claim(code: string, raw: unknown, signature: string) {
    await this.ready;
    const identity = DeviceIdentity.parse(raw);
    if (new Set(identity.projects.map((p) => p.id)).size !== identity.projects.length)
      throw new AppError(ErrorCode.BadRequest, "项目列表包含重复项");
    this.verifyKey(identity.publicKey, devicePairProof(this.origin, code, identity), signature);
    return await this.db.transaction(async () => {
      const pair = (await this.db
        .prepare("SELECT * FROM device_pairings WHERE code_hash=?")
        .get(this.hash(code))) as PairRow | undefined;
      if (!pair || pair.expires <= this.now() || pair.host_id)
        throw new AppError(ErrorCode.Unauthorized, "配对码已使用或过期");
      const id = `office-${randomUUID()}`;
      const fingerprint = createHash("sha256")
        .update(Buffer.from(identity.publicKey, "base64"))
        .digest("hex");
      await this.db
        .prepare(
          "INSERT INTO devices(id,user_id,identity,fingerprint,projects,state) VALUES(?,?,?,?,?,'pending')",
        )
        .run(id, pair.user_id, JSON.stringify(identity), fingerprint, "[]");
      await this.db
        .prepare("UPDATE device_pairings SET host_id=? WHERE id=? AND host_id IS NULL")
        .run(id, pair.id);
      return {
        hostId: id,
        pairingId: pair.id,
        fingerprint,
        expiresAt: new Date(pair.expires).toISOString(),
      };
    })();
  }
  async pairing(actor: RemoteActor, id: string) {
    await this.ready;
    const pair = (await this.db
      .prepare("SELECT * FROM device_pairings WHERE id=? AND user_id=?")
      .get(id, actor.userId)) as PairRow | undefined;
    if (!pair || pair.expires <= this.now()) throw new AppError(ErrorCode.NotFound, "配对已过期");
    return {
      id,
      expiresAt: new Date(pair.expires).toISOString(),
      device: pair.host_id ? await this.get(pair.host_id, actor.userId) : null,
    };
  }
  async confirmPairing(
    actor: RemoteActor,
    pairingId: string,
    fingerprint: string,
    projects: string[],
  ) {
    await this.ready;
    this.recent(actor);
    return await this.db.transaction(async () => {
      const pair = await this.pairing(actor, pairingId),
        device = pair.device;
      if (
        !device ||
        device.fingerprint !== fingerprint ||
        !projects.length ||
        new Set(projects).size !== projects.length ||
        projects.some((id) => !device.identity.projects.some((p) => p.id === id))
      )
        throw new AppError(ErrorCode.Forbidden, "请核对设备指纹和授权项目");
      if (device.state !== "pending") throw new AppError(ErrorCode.Conflict, "配对已确认或撤销");
      await this.db
        .prepare("UPDATE devices SET state='confirmed',projects=? WHERE id=?")
        .run(JSON.stringify(projects), device.id);
      return await this.get(device.id, actor.userId);
    })();
  }
  async get(id: string, userId?: string) {
    await this.ready;
    const row = (await this.db.prepare("SELECT * FROM devices WHERE id=?").get(id)) as
      DeviceRow | undefined;
    if (!row || (userId && row.user_id !== userId))
      throw new AppError(ErrorCode.NotFound, "设备不存在");
    return {
      id: row.id,
      userId: row.user_id,
      identity: DeviceIdentity.parse(JSON.parse(row.identity)),
      fingerprint: row.fingerprint,
      projects: JSON.parse(row.projects),
      state: row.state,
      epoch: row.epoch,
      lastSeen: row.last_seen,
    };
  }
  async list(userId: string) {
    await this.ready;
    return Promise.all(
      (
        (await this.db
          .prepare("SELECT id FROM devices WHERE user_id=? AND state!='revoked'")
          .all(userId)) as {
          id: string;
        }[]
      ).map(async (row) => await this.get(row.id)),
    );
  }
  async challenge(hostId: string, purpose: DevicePurpose) {
    await this.ready;
    await this.prune();
    const device = await this.get(hostId);
    if (device.state === "revoked") throw new AppError(ErrorCode.Unauthorized, "设备已撤销");
    const id = randomUUID(),
      nonce = randomBytes(32).toString("base64url"),
      expires = this.now() + 30000;
    await this.db
      .prepare("INSERT INTO device_challenges VALUES(?,?,?,?,?)")
      .run(id, hostId, purpose, nonce, expires);
    return { id, nonce, expiresAt: new Date(expires).toISOString() };
  }
  async authenticate(id: string, signature: string) {
    await this.ready;
    return await this.db.transaction(async () => {
      const challenge = (await this.db
        .prepare("SELECT * FROM device_challenges WHERE id=?")
        .get(id)) as
        | {
            host_id: string;
            purpose: DevicePurpose;
            nonce: string;
            expires: number;
          }
        | undefined;
      if (!challenge || challenge.expires <= this.now())
        throw new AppError(ErrorCode.Unauthorized, "设备挑战已失效");
      const device = await this.get(challenge.host_id);
      if (device.state === "revoked") throw new AppError(ErrorCode.Unauthorized, "设备已撤销");
      this.verifyKey(
        device.identity.publicKey,
        deviceProof(this.origin, device.id, challenge.purpose, challenge.nonce),
        signature,
      );
      await this.db.prepare("DELETE FROM device_challenges WHERE id=?").run(id);
      return { device, purpose: challenge.purpose };
    })();
  }
  async localConfirm(hostId: string) {
    await this.ready;
    return await this.db.transaction(async () => {
      const pair = (await this.db
        .prepare("SELECT * FROM device_pairings WHERE host_id=?")
        .get(hostId)) as PairRow | undefined;
      if (!pair || pair.expires <= this.now() || (await this.get(hostId)).state !== "confirmed")
        throw new AppError(ErrorCode.Forbidden, "请先在手机确认配对，或重新创建配对码");
      await this.db.prepare("UPDATE devices SET state='active' WHERE id=?").run(hostId);
      return await this.get(hostId);
    })();
  }
  async token(hostId: string) {
    await this.ready;
    return await this.db.transaction(async () => {
      if ((await this.get(hostId)).state !== "active")
        throw new AppError(ErrorCode.Forbidden, "双方尚未完成配对确认");
      const token = randomBytes(32).toString("base64url");
      await this.db
        .prepare("INSERT INTO device_tokens VALUES(?,?,?)")
        .run(this.hash(token), hostId, this.now() + 30000);
      return { token, expiresAt: new Date(this.now() + 30000).toISOString() };
    })();
  }
  async consumeToken(token: string) {
    await this.ready;
    return await this.db.transaction(async () => {
      const row = (await this.db
        .prepare("SELECT * FROM device_tokens WHERE hash=?")
        .get(this.hash(token))) as
        | {
            host_id: string;
            expires: number;
          }
        | undefined;
      if (!row || row.expires <= this.now())
        throw new AppError(ErrorCode.Unauthorized, "设备连接令牌已失效");
      await this.db.prepare("DELETE FROM device_tokens WHERE hash=?").run(this.hash(token));
      if ((await this.get(row.host_id)).state !== "active")
        throw new AppError(ErrorCode.Unauthorized, "设备已撤销");
      await this.db
        .prepare("UPDATE devices SET epoch=epoch+1,last_seen=? WHERE id=?")
        .run(this.now(), row.host_id);
      return await this.get(row.host_id);
    })();
  }
  async heartbeat(hostId: string, epoch: number) {
    await this.ready;
    return (
      (
        await this.db
          .prepare("UPDATE devices SET last_seen=? WHERE id=? AND epoch=? AND state='active'")
          .run(this.now(), hostId, epoch)
      ).changes === 1
    );
  }
  async revoke(hostId: string, actor?: RemoteActor) {
    await this.ready;
    return await this.db.transaction(async () => {
      if (actor) {
        this.recent(actor);
        await this.get(hostId, actor.userId);
      }
      await this.db
        .prepare("UPDATE devices SET state='revoked',epoch=epoch+1 WHERE id=?")
        .run(hostId);
      await this.db.prepare("DELETE FROM device_tokens WHERE host_id=?").run(hostId);
      await this.db.prepare("DELETE FROM device_challenges WHERE host_id=?").run(hostId);
    })();
  }
  private verifyKey(publicKey: string, value: string, signature: string) {
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        key.asymmetricKeyType !== "ed25519" ||
        !verify(null, Buffer.from(value), key, Buffer.from(signature, "base64"))
      )
        throw new Error();
    } catch {
      throw new AppError(ErrorCode.Unauthorized, "设备签名无效");
    }
  }
  private async prune() {
    await this.ready;
    return await this.db.transaction(async () => {
      await this.db.prepare("DELETE FROM device_challenges WHERE expires<=?").run(this.now());
      await this.db.prepare("DELETE FROM device_tokens WHERE expires<=?").run(this.now());
      await this.db
        .prepare(
          "UPDATE devices SET state='revoked' WHERE state IN ('pending','confirmed') AND id IN (SELECT host_id FROM device_pairings WHERE expires<=?)",
        )
        .run(this.now());
      await this.db.prepare("DELETE FROM device_pairings WHERE expires<=?").run(this.now());
    })();
  }
}

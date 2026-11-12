import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { gatewayDatabase, type GatewayDatabase } from "../db/database";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  RemoteId,
  SnapshotManifest,
  type RemoteActor,
  type RemoteScope,
} from "@agentdesk/shared";
import type { RemoteGatewayService } from "./service";
import type { RemoteRoutingStore } from "./store";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface Transfer {
  id: string;
  actor: RemoteActor;
  source: RemoteScope;
  target: RemoteScope;
  snapshotId: string;
  destinationId: string;
  manifest: SnapshotManifest;
  manifestDigest: string;
  state: "transferring" | "ready" | "importing" | "verified" | "paused" | "failed";
  file: number;
  offset: number;
  bytes: number;
  error?: string;
  result?: unknown;
  createdAt: number;
}
interface Chunk {
  data: string;
  sha256: string;
  offset: number;
  total: number;
}
export class GatewayTransfers {
  readonly db: GatewayDatabase;
  readonly ready: Promise<void>;
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scan: Promise<void> | undefined;
  constructor(
    database: Database.Database | GatewayDatabase,
    private readonly remote: RemoteGatewayService,
    private readonly routing: RemoteRoutingStore,
  ) {
    this.db = gatewayDatabase(database);
    this.ready = this.initialize();
  }
  private async initialize() {
    await this.db
      .exec(`CREATE TABLE IF NOT EXISTS gateway_transfers (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,value_json TEXT NOT NULL,UNIQUE(user_id,request_id));`);
  }
  private async save(value: Transfer) {
    await this.ready;
    await this.db
      .prepare("UPDATE gateway_transfers SET value_json=? WHERE id=?")
      .run(JSON.stringify(value), value.id);
  }
  private async read(actor: RemoteActor, id: string) {
    await this.ready;
    RemoteId.parse(id);
    const row = (await this.db
      .prepare("SELECT value_json FROM gateway_transfers WHERE id=? AND user_id=?")
      .get(id, actor.userId)) as
      | {
          value_json: string;
        }
      | undefined;
    if (!row) throw new AppError(ErrorCode.NotFound, "传输不存在");
    return JSON.parse(row.value_json) as Transfer;
  }
  private public(value: Transfer) {
    return {
      id: value.id,
      state: value.state,
      bytes: value.bytes,
      file: value.file,
      error: value.error,
      result: value.result,
      sourceHostId: value.source.hostId,
      sourceProjectId: value.source.projectId,
      targetProjectId: value.target.projectId,
      manifest: value.manifest,
      manifestDigest: value.manifestDigest,
      createdAt: new Date(value.createdAt).toISOString(),
    };
  }
  async create(actor: RemoteActor, raw: unknown) {
    await this.ready;
    const input = z
      .strictObject({
        clientRequestId: RemoteId,
        sourceHostId: RemoteId,
        sourceProjectId: RemoteId,
        snapshotId: RemoteId,
        targetProjectId: RemoteId,
      })
      .parse(raw);
    const requestHash = digest(JSON.stringify(input));
    const existing = (await this.db
      .prepare("SELECT id,payload_hash FROM gateway_transfers WHERE user_id=? AND request_id=?")
      .get(actor.userId, input.clientRequestId)) as
      | {
          id: string;
          payload_hash: string;
        }
      | undefined;
    if (existing) {
      if (existing.payload_hash !== requestHash)
        throw new AppError(ErrorCode.IdempotencyConflict, "传输请求内容已改变");
      return await this.get(actor, existing.id);
    }
    const source = await this.remote.scope(actor, input.sourceHostId, input.sourceProjectId),
      target = await this.remote.scope(actor, "cloud", input.targetProjectId);
    const description = await this.remote.client.execute<{
      manifestDigest: string;
      manifestBytes: number;
    }>(source, actor, "snapshot.read", { kind: "describe", snapshotId: input.snapshotId });
    if (description.manifestBytes > 2 * 1024 * 1024)
      throw new AppError(ErrorCode.TransferQuotaExceeded, "快照清单过大，请分批选择文件");
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < description.manifestBytes) {
      const chunk = await this.remote.client.execute<Chunk>(source, actor, "snapshot.read", {
        kind: "chunk",
        snapshotId: input.snapshotId,
        file: "manifest",
        offset,
      });
      const bytes = this.verify(chunk, offset, description.manifestBytes);
      parts.push(bytes);
      offset += bytes.length;
    }
    const text = Buffer.concat(parts).toString("utf8");
    if (digest(text) !== description.manifestDigest)
      throw new AppError(ErrorCode.BadRequest, "快照清单校验失败");
    const manifest = SnapshotManifest.parse(JSON.parse(text));
    if (
      manifest.sourceHostId !== source.hostId ||
      manifest.sourceProjectId !== source.projectId ||
      manifest.sourceWorkspaceId !== source.workspaceId ||
      manifest.snapshotId !== input.snapshotId
    )
      throw new AppError(ErrorCode.Forbidden, "快照来源与授权不匹配");
    // 命令通道有严格大小上限，超限时请拆分选取，不能静默截断清单。
    if (Buffer.byteLength(text) > 160000)
      throw new AppError(ErrorCode.TransferQuotaExceeded, "文件清单过大，请分批取回");
    const begun = await this.remote.client.execute<{
      id: string;
    }>(
      target,
      actor,
      "transfer.import",
      {
        kind: "begin",
        clientRequestId: input.clientRequestId,
        manifest,
        manifestDigest: description.manifestDigest,
      },
      input.clientRequestId,
    );
    const value: Transfer = {
      id: randomUUID(),
      actor,
      source,
      target,
      snapshotId: input.snapshotId,
      destinationId: begun.id,
      manifest,
      manifestDigest: description.manifestDigest,
      state: "transferring",
      file: 0,
      offset: 0,
      bytes: 0,
      createdAt: Date.now(),
    };
    await this.db
      .prepare("INSERT INTO gateway_transfers VALUES(?,?,?,?,?)")
      .run(value.id, actor.userId, input.clientRequestId, requestHash, JSON.stringify(value));
    await this.pump(value);
    return this.public(value);
  }
  async get(actor: RemoteActor, id: string) {
    await this.ready;
    const value = await this.read(actor, id);
    if (value.state === "importing") {
      const actual = await this.remote.client.execute<{
        status: string;
        result: unknown;
      }>(value.target, actor, "snapshot.read", {
        kind: "transfer",
        transferId: value.destinationId,
      });
      if (actual.status === "verified") {
        value.state = "verified";
        value.result = actual.result;
        await this.save(value);
      } else if (actual.status === "failed") {
        value.state = "failed";
        value.error = "恢复中断，隔离工作区已保留，请检查执行宿主后重新创建取回请求";
        await this.save(value);
      } else if (actual.status === "transferring") {
        value.state = "paused";
        value.file = 0;
        value.offset = 0;
        value.bytes = 0;
        value.error = "恢复前校验未通过，请续传并重新核对分块";
        await this.save(value);
      }
    }
    return this.public(value);
  }
  async list(actor: RemoteActor) {
    await this.ready;
    return (
      (await this.db
        .prepare(
          this.db.dialect === "postgres"
            ? "SELECT value_json FROM gateway_transfers WHERE user_id=? ORDER BY (value_json::jsonb->>'createdAt')::bigint DESC,id DESC LIMIT 30"
            : "SELECT value_json FROM gateway_transfers WHERE user_id=? ORDER BY rowid DESC LIMIT 30",
        )
        .all(actor.userId)) as {
        value_json: string;
      }[]
    ).map((row) => this.public(JSON.parse(row.value_json) as Transfer));
  }
  async resume(actor: RemoteActor, id: string) {
    await this.ready;
    const value = await this.read(actor, id);
    if (value.state !== "paused") throw new AppError(ErrorCode.Conflict, "当前传输不需要续传");
    await this.remote.scope(actor, value.source.hostId, value.source.projectId);
    await this.remote.scope(actor, "cloud", value.target.projectId);
    const actual = await this.remote.client.execute<{
      status: string;
    }>(value.target, actor, "snapshot.read", { kind: "transfer", transferId: value.destinationId });
    if (actual.status !== "transferring")
      throw new AppError(ErrorCode.Conflict, "恢复已开始，请刷新状态并保留隔离工作区");
    value.actor = actor;
    value.state = "transferring";
    delete value.error;
    await this.save(value);
    await this.pump(value);
    return this.public(value);
  }
  async import(actor: RemoteActor, id: string, manifestDigest: string) {
    await this.ready;
    const value = await this.read(actor, id);
    if (value.manifestDigest !== manifestDigest)
      throw new AppError(ErrorCode.StalePreview, "清单已变化，请重新审阅");
    if (value.state === "verified" || value.state === "importing") return await this.get(actor, id);
    if (value.state !== "ready") throw new AppError(ErrorCode.Conflict, "文件尚未全部传输并校验");
    value.state = "importing";
    await this.save(value);
    try {
      const result = await this.remote.client.execute<{
        status: string;
        result: unknown;
      }>(
        value.target,
        actor,
        "transfer.import",
        { kind: "import", transferId: value.destinationId, manifestDigest },
        value.id,
      );
      if (result.status === "verified") {
        value.state = "verified";
        value.result = result.result;
        await this.save(value);
      }
      return this.public(value);
    } catch (error) {
      // 调用失败不等于宿主没有执行；保留 importing，由 GET 查询权威结果。
      value.error = "正在核对恢复结果，请刷新状态";
      await this.save(value);
      throw error;
    }
  }
  private verify(chunk: Chunk, offset: number, total: number) {
    const bytes = Buffer.from(chunk.data, "base64");
    if (
      chunk.offset !== offset ||
      chunk.total !== total ||
      bytes.length !== Math.min(48 * 1024, total - offset) ||
      bytes.toString("base64") !== chunk.data ||
      digest(bytes) !== chunk.sha256
    )
      throw new AppError(ErrorCode.BadRequest, "文件分块校验失败");
    return bytes;
  }
  private async pump(value: Transfer) {
    if (this.stopping || this.active.has(value.id) || this.active.size >= 2) return;
    const work = this.run(value)
      .catch(() => {
        // 数据库故障时保留最后一次持久状态，下一轮扫描重新尝试。
      })
      .finally(() => this.active.delete(value.id));
    this.active.set(value.id, work);
  }
  private async run(value: Transfer) {
    await this.ready;
    try {
      while (value.file < value.manifest.entries.length) {
        if (this.stopping) return;
        if (!(await this.routing.sessionAlive(value.actor)))
          throw new AppError(ErrorCode.Unauthorized, "登录已过期，请重新登录后续传");
        const entry = value.manifest.entries[value.file]!;
        if (entry.kind === "deleted" || value.offset >= entry.size) {
          value.file++;
          value.offset = 0;
          await this.save(value);
          continue;
        }
        const chunk = await this.remote.client.execute<Chunk>(
          value.source,
          value.actor,
          "snapshot.read",
          { kind: "chunk", snapshotId: value.snapshotId, file: value.file, offset: value.offset },
        );
        const bytes = this.verify(chunk, value.offset, entry.size);
        await this.remote.client.execute(value.target, value.actor, "transfer.import", {
          kind: "upload",
          transferId: value.destinationId,
          file: value.file,
          offset: value.offset,
          data: chunk.data,
          sha256: chunk.sha256,
        });
        value.offset += bytes.length;
        value.bytes += bytes.length;
        await this.save(value);
      }
      value.state = "ready";
      await this.save(value);
    } catch (error) {
      value.state = "paused";
      value.error = error instanceof AppError ? error.message : "传输中断，请检查两端连接后续传";
      await this.save(value);
    }
  }
  async start() {
    await this.ready;
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(async () => {
      if (this.scan || this.stopping) return;
      this.scan = this.scanPending()
        .catch(() => undefined)
        .finally(() => {
          this.scan = undefined;
        });
    }, 5000);
    this.timer.unref();
  }
  private async scanPending() {
    const rows = (await this.db.prepare("SELECT value_json FROM gateway_transfers").all()) as {
      value_json: string;
    }[];
    for (const row of rows) {
      const value = JSON.parse(row.value_json) as Transfer;
      if (value.state === "transferring") await this.pump(value);
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.scan;
    await Promise.allSettled(this.active.values());
  }
}

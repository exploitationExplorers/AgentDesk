import type { IndexedSession } from "./codex-history";
import { searchSessions, resolveGithubPr, resolveLocalPr, type HubFilter } from "./search";
import { parseHubPr } from "@agentdesk/shared";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  AppError,
  ErrorCode,
  hubKey,
  hubToolNames,
  type HubIndex,
  type HubLinkFields,
  type HubWebEntry,
  type HubRecord,
  type HubSnapshot,
} from "@agentdesk/shared";
import type { DbHandle } from "../../db/client";
import { Collection } from "../../db/collection";
import type { sessionSources } from "./sources";
import { record } from "./record";

import { hasCloudDrive, syncDeviceFiles } from "./sync";

type Sources = ReturnType<typeof sessionSources>;
type Binding = { id: string; prs: number[] } & Pick<HubLinkFields, "title" | "url" | "note">;
export class SessionHub {
  private readonly device: { id: string; deviceId: string };
  private readonly scans: Collection<{ id: string; records: HubRecord[] }>;
  private readonly web: Collection<HubRecord>;
  private readonly bindings: Collection<Binding>;
  private readonly peers: Collection<{ id: string; snapshot: HubSnapshot }>;
  private readonly preferences: Collection<{ id: string; enabled: boolean }>;
  private cloudRun?: Promise<number>;
  private readonly corpus = new Map<string, string>();
  private updated = 0;
  private warnings: string[] = [];
  private pending?: Promise<void>;
  constructor(
    handle: DbHandle,
    private sources: Sources,
  ) {
    const identity = new Collection<{ id: string; deviceId: string }>(
      handle.db,
      "sessionHubIdentity",
    );
    this.device = handle.raw.transaction(
      () => identity.get("local") ?? identity.put({ id: "local", deviceId: randomUUID() }),
    )();
    this.scans = new Collection(handle.db, "sessionHubIndex");
    this.preferences = new Collection(handle.db, "sessionHubPreferences");
    this.web = new Collection(handle.db, "sessionHubWeb");
    this.bindings = new Collection(handle.db, "sessionHubPrs");
    this.peers = new Collection(handle.db, "sessionHubDevices");
  }
  private async refresh() {
    const results = await Promise.allSettled(
      Object.entries(this.sources).map(async ([id, read]) => {
        const rows: IndexedSession[] = await read();
        const records = rows
          .map(({ searchText: _searchText, ...row }) => row)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (id === "codex") {
          this.corpus.clear();
          for (const row of rows)
            if (row.searchText) this.corpus.set(hubKey(this.device.deviceId, row), row.searchText);
        }
        if (JSON.stringify(this.scans.get(id)?.records) !== JSON.stringify(records))
          this.scans.put({ id, records });
      }),
    );
    this.warnings = Object.keys(this.sources)
      .filter((_, i) => results[i]?.status === "rejected")
      .map((key) => `${hubToolNames[key as keyof Sources]} 索引读取失败，已保留上次结果。`);
    this.updated = Date.now();
  }
  async index(force = false, syncCloud = true): Promise<HubIndex> {
    if (force || Date.now() - this.updated > 60000)
      this.pending ??= this.refresh().finally(() => {
        this.pending = undefined;
      });
    await this.pending;
    const bindings = new Map(this.bindings.list().map((b) => [b.id, b]));
    const sessions = [...this.scans.list().flatMap((s) => s.records), ...this.web.list()].map(
      (row) => {
        const binding = bindings.get(hubKey(this.device.deviceId, row));
        if (!binding) return row;
        const { id: _id, prs, ...metadata } = binding;
        return { ...row, ...metadata, prs: [...new Set([...row.prs, ...prs])] };
      },
    );
    const local: HubSnapshot = {
      format: "agentdesk-session-index-v1",
      deviceId: this.device.deviceId,
      deviceName: hostname(),
      sessions: sessions.sort((a, b) => a.tool.localeCompare(b.tool) || a.id.localeCompare(b.id)),
    };
    const cloud = {
      available: hasCloudDrive(),
      enabled: this.preferences.get("cloud")?.enabled === true,
    };
    const warnings = [...this.warnings];
    if (syncCloud && cloud.enabled && cloud.available) {
      try {
        this.cloudRun ??= syncDeviceFiles(local, (peer) => this.import(peer)).finally(() => {
          this.cloudRun = undefined;
        });
        if (await this.cloudRun) warnings.push("部分设备索引读取失败，保留了此前的记录。");
      } catch {
        warnings.push("iCloud 索引同步失败，请检查 iCloud 云盘是否可写。");
      }
    }
    if (cloud.enabled && !cloud.available) warnings.push("iCloud 云盘当前不可用。");
    return { local, devices: this.peers.list().map((p) => p.snapshot), cloud, warnings };
  }
  async search(filters: HubFilter, remote: boolean) {
    const start = performance.now();
    const index = await this.index(false, false);
    const pr = parseHubPr(filters.query);
    let resolved = null;
    if (pr && remote) {
      try {
        resolved = await resolveGithubPr(index, pr, filters.tool);
      } catch {
        /* gh unavailable, unauthenticated or the repository has no such PR */
      }
      if (!resolved)
        throw new AppError(
          ErrorCode.IntegrationFailed,
          `未查到 PR #${pr.number}。请确认 gh 已登录，或用 owner/repo#${pr.number} 指定仓库。`,
        );
    }
    if (pr && !remote && !pr.repo && (!filters.device || filters.device === index.local.deviceId))
      resolved = await resolveLocalPr(index, pr.number, filters.tool);
    const result = searchSessions(index, this.corpus, filters, resolved);
    return { ...result, elapsedMs: Math.round(performance.now() - start) };
  }
  setCloud(enabled: boolean) {
    if (enabled && !hasCloudDrive())
      throw new AppError(ErrorCode.BadRequest, "未检测到 iCloud 云盘。");
    this.preferences.put({ id: "cloud", enabled });
  }

  async localRow(key: string) {
    const { local } = await this.index(false, false);
    const row = local.sessions.find((r) => hubKey(local.deviceId, r) === key);
    if (!row) throw new AppError(ErrorCode.NotFound, "未找到本机会话，请重新同步索引。");
    return row;
  }
  async bind(key: string, fields: HubLinkFields) {
    const row = await this.localRow(key);
    const { pr, ...metadata } = fields;
    const previous = this.bindings.get(key);
    const prs = [...new Set([...(previous?.prs ?? []), ...(pr ? [pr] : [])])];
    if (new Set([...row.prs, ...prs]).size > 64)
      throw new AppError(ErrorCode.BadRequest, "每个会话最多关联 64 个 PR。");
    this.bindings.put({ ...previous, ...metadata, id: key, prs });
  }
  addWeb({ title, url, pr, note, manualTool }: HubWebEntry) {
    const existing = url ? this.web.list().find((r) => r.url === url) : undefined;
    const label =
      title ?? existing?.title ?? (note?.slice(0, 300) || (pr ? `PR #${pr}` : url?.slice(0, 300)));
    const row = existing ?? record("web", randomUUID(), { title: label });
    const prs = [...new Set([...row.prs, ...(pr ? [pr] : [])])];
    if (prs.length > 64) throw new AppError(ErrorCode.BadRequest, "每个会话最多关联 64 个 PR。");
    this.web.put({
      ...row,
      title: label ?? row.title,
      url,
      note: note ?? row.note,
      manualTool: manualTool ?? row.manualTool,
      updatedAt: Date.now(),
      prs,
    });
    return hubKey(this.device.deviceId, row);
  }
  import(snapshot: HubSnapshot) {
    if (snapshot.deviceId === this.device.deviceId)
      throw new AppError(ErrorCode.BadRequest, "这是本机的索引，请选择其他设备导出的文件。");
    const seen = new Set(snapshot.sessions.map((r) => hubKey(snapshot.deviceId, r)));
    if (seen.size !== snapshot.sessions.length)
      throw new AppError(ErrorCode.BadRequest, "设备索引中存在重复会话。");
    if (JSON.stringify(this.peers.get(snapshot.deviceId)?.snapshot) !== JSON.stringify(snapshot))
      this.peers.put({ id: snapshot.deviceId, snapshot });
  }
}

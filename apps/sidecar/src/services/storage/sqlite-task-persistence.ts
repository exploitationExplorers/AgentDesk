import { businessDatabase, type BusinessDatabase } from "../../db/business-database";
import { sqliteDocuments } from "./async-documents";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  AppError,
  ErrorCode,
  type Artifact,
  type ArtifactKind,
  type Run,
  type Task,
} from "@agentdesk/shared";
import type { DbHandle } from "../../db/client";
import { Collection } from "../../db/collection";
import { runs, artifacts } from "../../db/schema";
import { SqliteEventStore } from "./sqlite-event-store";
import type {
  AsyncDocumentRepository,
  TaskPersistence,
  RunRepository,
  ArtifactRepository,
  AsyncEventStore,
} from "./async-ports";

/** 桌面存储仍用原 SQLite 表，通过串行队列支持跨 await 的事务。 */
export class SqliteTaskPersistence implements TaskPersistence {
  readonly tasks: AsyncDocumentRepository<Task>;
  readonly runs: RunRepository;
  readonly artifacts: ArtifactRepository;
  readonly events: AsyncEventStore;
  readonly business: BusinessDatabase;
  documents<T extends { id: string }>(name: string) {
    return sqliteDocuments<T>(this.handle.db, name);
  }
  constructor(private readonly handle: DbHandle) {
    this.business = businessDatabase(handle.raw);
    const db = handle.db,
      tasks = new Collection<Task>(db, "tasks"),
      events = new SqliteEventStore(db);
    const run = (row: typeof runs.$inferSelect) => row as Run;
    const artifact = (row: typeof artifacts.$inferSelect): Artifact => {
      const metadata = row.metadata as Record<string, unknown> | null;
      // 旧表中的版本 key 存在 metadata，领域服务负责补齐旧数据的文件 key。
      return {
        ...row,
        kind: row.kind as ArtifactKind,
        metadata: row.metadata as Artifact["metadata"],
        artifactKey: typeof metadata?.artifactKey === "string" ? metadata.artifactKey : row.kind,
      };
    };
    this.tasks = {
      get: (id) => this.exclusive(async () => tasks.get(id)),
      list: () => this.exclusive(async () => tasks.list()),
      put: (value) => this.exclusive(async () => tasks.put(value)),
      update: (id, change) => this.exclusive(async () => tasks.update(id, change)),
      delete: (id) => this.exclusive(async () => tasks.delete(id)),
    };
    this.runs = {
      get: (id) =>
        this.exclusive(async () => {
          const row = db.select().from(runs).where(eq(runs.id, id)).get();
          return row ? run(row) : undefined;
        }),
      list: (taskId) =>
        this.exclusive(async () =>
          db
            .select()
            .from(runs)
            .where(eq(runs.taskId, taskId))
            .orderBy(asc(runs.createdAt))
            .all()
            .map(run),
        ),
      findByIdempotency: (key) =>
        this.exclusive(async () => {
          const row = db.select().from(runs).where(eq(runs.idempotencyKey, key)).get();
          return row ? run(row) : undefined;
        }),
      activeForTasks: (taskIds) =>
        this.exclusive(
          async () =>
            !!(
              taskIds.length &&
              db
                .select({ id: runs.id })
                .from(runs)
                .where(
                  and(inArray(runs.taskId, taskIds), inArray(runs.status, ["queued", "running"])),
                )
                .get()
            ),
        ),
      byStatus: (status, owner) =>
        this.exclusive(async () =>
          db
            .select()
            .from(runs)
            .where(and(eq(runs.status, status), eq(runs.executionOwner, owner ?? "local")))
            .orderBy(asc(runs.createdAt))
            .all()
            .map(run),
        ),
      insert: (value) =>
        this.exclusive(async () => {
          db.insert(runs)
            .values({ ...value, executionOwner: value.executionOwner ?? "local" })
            .run();
          return value;
        }),
      update: (id, patch) =>
        this.exclusive(async () => {
          const row = db.select().from(runs).where(eq(runs.id, id)).get();
          if (!row) throw new AppError(ErrorCode.NotFound, "运行不存在");
          if ((patch.id && patch.id !== id) || (patch.taskId && patch.taskId !== row.taskId))
            throw new Error("Run identity cannot change");
          db.update(runs).set(patch).where(eq(runs.id, id)).run();
          return run(db.select().from(runs).where(eq(runs.id, id)).get()!);
        }),
    };
    this.artifacts = {
      get: (taskId, id) =>
        this.exclusive(async () => {
          const row = db
            .select()
            .from(artifacts)
            .where(and(eq(artifacts.id, id), eq(artifacts.taskId, taskId)))
            .get();
          return row ? artifact(row) : undefined;
        }),
      list: (taskId, kind) =>
        this.exclusive(async () =>
          db
            .select()
            .from(artifacts)
            .where(
              kind
                ? and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind))
                : eq(artifacts.taskId, taskId),
            )
            .orderBy(asc(artifacts.createdAt), asc(artifacts.version))
            .all()
            .map(artifact),
        ),
      insert: (value) =>
        this.exclusive(async () => {
          db.insert(artifacts).values(value).run();
          return value;
        }),
    };
    this.events = {
      append: (input) => this.exclusive(async () => events.append(input)),
      read: (input) => this.exclusive(async () => events.read(input)),
      prunedThrough: (filter) => this.exclusive(async () => events.prunedThrough(filter)),
    };
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.business.exclusive(action);
  }
  transaction<T>(action: () => Promise<T>): Promise<T> {
    return this.business.transaction(action).immediate();
  }
  isRemoteTask(taskId: string) {
    return this.exclusive(
      async () =>
        !!this.handle.db.get(sql`SELECT 1 FROM remote_task_contexts WHERE task_id=${taskId}`),
    );
  }
}

import type Database from "better-sqlite3";
import type { RetentionStore } from "./ports";

/** 每批最多回收 1,000 条，水位和删除处于同一事务，避免重连静默缺历史。 */
export class SqliteRetentionStore implements RetentionStore {
  constructor(private readonly db: Database.Database) {}

  count(taskIds: string[], conversationIds: string[], eventCutoff: string, traceCutoff: string) {
    const eventCount = this.db.prepare(
      "SELECT count(*) AS n FROM (SELECT 1 FROM run_events WHERE task_id=? AND created_at<? LIMIT 1000)",
    );
    const traceCount = this.db.prepare(
      "SELECT count(*) AS n FROM (SELECT 1 FROM traces WHERE scope=? AND created_at<? LIMIT 1000)",
    );
    return {
      events: taskIds.reduce(
        (n, id) => n + Math.min(1000, (eventCount.get(id, eventCutoff) as { n: number }).n),
        0,
      ),
      traces: [...new Set(conversationIds)].reduce(
        (n, id) =>
          n + Math.min(1000, (traceCount.get(`chat:${id}`, traceCutoff) as { n: number }).n),
        0,
      ),
    };
  }

  prune(taskId: string, conversationId: string, eventCutoff: string, traceCutoff: string) {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id,run_id FROM run_events WHERE task_id=? AND created_at<? ORDER BY id LIMIT 1000",
        )
        .all(taskId, eventCutoff) as Array<{ id: number; run_id: string }>;
      const watermark = this.db
        .prepare(`INSERT INTO event_retention(run_id,task_id,pruned_through) VALUES(?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET pruned_through=max(pruned_through,excluded.pruned_through)`);
      const remove = this.db.prepare("DELETE FROM run_events WHERE id=?");
      for (const row of rows) {
        watermark.run(row.run_id, taskId, row.id);
        remove.run(row.id);
      }
      const traces = conversationId
        ? this.db
            .prepare(
              `DELETE FROM traces WHERE id IN (
        SELECT id FROM traces WHERE scope=? AND created_at<? ORDER BY id LIMIT 1000
      )`,
            )
            .run(`chat:${conversationId}`, traceCutoff).changes
        : 0;
      return { events: rows.length, traces };
    })();
  }

  referencesFile(name: string): boolean {
    // 只查询是否命中，不把私密正文返回存储管理器；宁可多保留，避免误删引用。
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM (
      SELECT data AS body FROM documents UNION ALL SELECT content FROM messages
      UNION ALL SELECT event FROM run_events UNION ALL SELECT event FROM traces
      UNION ALL SELECT coalesce(file_path,'') || coalesce(content,'') || coalesce(metadata,'') FROM artifacts
    ) WHERE instr(body,?)>0 LIMIT 1`,
        )
        .get(name),
    );
  }

  hasPendingApproval(taskId: string, conversationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM documents WHERE collection='approvals'
      AND json_extract(data,'$.status')='pending' AND (
        json_extract(data,'$.payload.taskId')=? OR json_extract(data,'$.conversationId')=?
      ) LIMIT 1`,
        )
        .get(taskId, conversationId),
    );
  }

  checkpoint(): void {
    // PASSIVE 不等待长读事务；不在在线清理时执行 VACUUM。
    this.db.pragma("wal_checkpoint(PASSIVE)");
  }
}

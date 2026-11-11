import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { RunEventRecord, TaskStreamEvent } from "@agentdesk/shared";
import type { Db } from "../../db/client";
import { eventRetention, runEvents } from "../../db/schema";
import type { EventFilter, EventStore } from "./ports";

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  append(input: Parameters<EventStore["append"]>[0]): RunEventRecord {
    const result = this.db.insert(runEvents).values(input).run();
    return { ...input, seq: Number(result.lastInsertRowid) };
  }

  read(input: EventFilter & { after: number; limit: number }): RunEventRecord[] {
    const scope = input.runId
      ? eq(runEvents.runId, input.runId)
      : eq(runEvents.taskId, input.taskId!);
    return this.db
      .select()
      .from(runEvents)
      .where(and(scope, gt(runEvents.id, input.after)))
      .orderBy(asc(runEvents.id))
      .limit(input.limit)
      .all()
      .map((row) => ({
        seq: row.id,
        taskId: row.taskId,
        runId: row.runId,
        parentRunId: row.parentRunId,
        event: row.event as TaskStreamEvent,
        createdAt: row.createdAt,
      }));
  }

  prunedThrough(filter: EventFilter): number {
    const scope = filter.runId
      ? eq(eventRetention.runId, filter.runId)
      : eq(eventRetention.taskId, filter.taskId!);
    return (
      this.db
        .select({ seq: sql<number>`coalesce(max(${eventRetention.prunedThrough}), 0)` })
        .from(eventRetention)
        .where(scope)
        .get()?.seq ?? 0
    );
  }
}

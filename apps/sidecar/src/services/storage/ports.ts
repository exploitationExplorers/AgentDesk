import type { RunEventRecord, TaskStreamEvent } from "@agentdesk/shared";

/** 领域服务只依赖这些端口，数据库适配器负责 SQL 和事务。 */
export interface DocumentRepository<T extends { id: string }> {
  get(id: string): T | undefined;
  list(): T[];
  put(value: T): T;
  update(id: string, change: (value: T) => T): T | undefined;
  delete(id: string): void;
}

export interface EventFilter {
  taskId?: string;
  runId?: string;
}

export interface EventStore {
  append(input: {
    taskId: string;
    runId: string;
    parentRunId: string | null;
    event: TaskStreamEvent;
    createdAt: string;
  }): RunEventRecord;
  read(input: EventFilter & { after: number; limit: number }): RunEventRecord[];
  prunedThrough(filter: EventFilter): number;
}

export interface CredentialVault {
  has(id: string): boolean;
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
}

export interface RetentionStore {
  count(
    taskIds: string[],
    conversationIds: string[],
    eventCutoff: string,
    traceCutoff: string,
  ): { events: number; traces: number };
  prune(
    taskId: string,
    conversationId: string,
    eventCutoff: string,
    traceCutoff: string,
  ): { events: number; traces: number };
  referencesFile(name: string): boolean;
  hasPendingApproval(taskId: string, conversationId: string): boolean;
  checkpoint(): void;
}

import type {
  Artifact,
  ArtifactKind,
  Run,
  RunEventRecord,
  Task,
  TaskStreamEvent,
} from "@agentdesk/shared";
import type { DurableCheckpoint } from "@agentdesk/agent-core";
import type { EventFilter } from "./ports";
import type { BusinessDatabase } from "../../db/business-database";

/** 云业务持久化端口不包含连接池、SQL 或本地凭据；调用者必须等待提交。 */
export interface AsyncDocumentRepository<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  put(value: T): Promise<T>;
  update(id: string, change: (value: T) => T): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
}
export interface AsyncEventStore {
  append(input: {
    taskId: string;
    runId: string;
    parentRunId: string | null;
    event: TaskStreamEvent;
    createdAt: string;
  }): Promise<RunEventRecord>;
  read(input: EventFilter & { after: number; limit: number }): Promise<RunEventRecord[]>;
  prunedThrough(filter: EventFilter): Promise<number>;
}
export interface RunRepository {
  get(id: string): Promise<Run | undefined>;
  list(taskId: string): Promise<Run[]>;
  findByIdempotency(key: string): Promise<Run | undefined>;
  activeForTasks(taskIds: string[]): Promise<boolean>;
  byStatus(status: Run["status"], owner: Run["executionOwner"]): Promise<Run[]>;
  insert(value: Run): Promise<Run>;
  update(id: string, patch: Partial<Run>): Promise<Run>;
}
export interface ArtifactRepository {
  get(taskId: string, id: string): Promise<Artifact | undefined>;
  list(taskId: string, kind?: ArtifactKind): Promise<Artifact[]>;
  insert(value: Artifact): Promise<Artifact>;
}
export interface CheckpointRepository {
  acquireEpoch(): Promise<number>;
  load(taskId: string): Promise<{ epoch: number; checkpoint: DurableCheckpoint } | undefined>;
  save(taskId: string, epoch: number, checkpoint: DurableCheckpoint): Promise<void>;
  stop(taskId: string): Promise<void>;
}
export interface TaskPersistence {
  readonly business: BusinessDatabase;
  documents<T extends { id: string }>(name: string): AsyncDocumentRepository<T>;
  tasks: AsyncDocumentRepository<Task>;
  runs: RunRepository;
  artifacts: ArtifactRepository;
  events: AsyncEventStore;
  transaction<T>(action: () => Promise<T>): Promise<T>;
  isRemoteTask(taskId: string): Promise<boolean>;
}

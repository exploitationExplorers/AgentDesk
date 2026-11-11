import {
  createInitialSession,
  sessionReducer,
  type RunEventRecord,
  type TaskSession,
} from "@agentdesk/shared";
import { createActivityProjector, type CodeActivity } from "./activity";

export interface TaskEventSnapshot {
  records: RunEventRecord[];
  activity: CodeActivity;
  runTree: TaskSession;
  recordCount: number;
  lastSeq: number;
}

interface TaskEventBufferOptions {
  taskId: string;
  onPublish: (snapshot: TaskEventSnapshot) => void;
  schedule?: (flush: () => void) => () => void;
}

function schedulePublish(flush: () => void) {
  const timer = setTimeout(flush, 32);
  return () => clearTimeout(timer);
}

/** 原始事件只追加一次；投影只消费新增事件，UI 按批接收不可变快照。 */
export function createTaskEventBuffer({
  taskId,
  onPublish,
  schedule = schedulePublish,
}: TaskEventBufferOptions) {
  const records: RunEventRecord[] = [];
  const projector = createActivityProjector();
  let pending: RunEventRecord[] = [];
  let lastSeq = 0;
  let disposed = false;
  let cancelPublish: (() => void) | undefined;
  let snapshot: TaskEventSnapshot = {
    records: [],
    activity: projector.getSnapshot(),
    runTree: createInitialSession(),
    recordCount: 0,
    lastSeq: 0,
  };

  function flush() {
    cancelPublish?.();
    cancelPublish = undefined;
    if (disposed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    snapshot = {
      // 协作视图仍需完整历史；只在发布时复制，避免逐事件复制全量数组。
      records: records.slice(),
      activity: projector.append(batch),
      runTree: batch.reduce(sessionReducer, snapshot.runTree),
      recordCount: records.length,
      lastSeq,
    };
    onPublish(snapshot);
  }

  function append(record: RunEventRecord) {
    if (disposed || record.taskId !== taskId || record.seq <= lastSeq) return;
    lastSeq = record.seq;
    records.push(record);
    pending.push(record);
    // 终态、错误和审批即时发布，不让操作状态滞留在尚未提交的批次中。
    if (
      record.event.type === "run_ended" ||
      record.event.type === "approval_required" ||
      record.event.type === "error"
    )
      flush();
    else cancelPublish ??= schedule(flush);
  }

  function dispose() {
    disposed = true;
    cancelPublish?.();
    cancelPublish = undefined;
    pending = [];
  }

  return {
    append,
    flush,
    dispose,
    getSnapshot: () => snapshot,
    // 返回副本，调用方无法修改缓冲中的原始历史。
    getRecords: (): readonly RunEventRecord[] => records.slice(),
  };
}

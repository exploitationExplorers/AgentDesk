import type {
  Artifact,
  Run,
  RunEventRecord,
  RunStatus,
  Task,
  TaskSession,
} from "@agentdesk/shared";

export type CollaborationStatus = RunStatus | "waiting";

export interface CollaborationRun {
  id: string;
  parentId: string | null;
  agent: Run["agent"];
  title: string;
  status: CollaborationStatus;
  startedAt: number;
  endedAt: number | null;
  result: string;
  error: string | null;
  toolCount: number;
  currentTool: string | null;
}

export interface CollaborationOutput {
  id: string;
  title: string;
  path: string | null;
  runId: string | null;
  kind: "artifact" | "change";
  createdAt: number;
}

export const COLLABORATION_STATUS: Record<CollaborationStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "待确认",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export const isRunActive = (status: CollaborationStatus) =>
  status === "running" || status === "waiting" || status === "queued";

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 合并轮询快照和事件流；终态事件优先，审批以服务端当前待处理列表为准。 */
export function buildCollaborationModel({
  task,
  runs,
  session,
  records,
  artifacts,
  pendingApprovalIds,
  rootId,
}: {
  task: Task;
  runs: Run[];
  session: TaskSession;
  records: RunEventRecord[];
  artifacts: Artifact[];
  pendingApprovalIds: ReadonlySet<string>;
  rootId?: string | null;
}) {
  const persisted = new Map(runs.map((run) => [run.id, run]));
  const byRun = new Map<string, RunEventRecord[]>();
  for (const record of records) {
    const bucket = byRun.get(record.runId) ?? [];
    bucket.push(record);
    byRun.set(record.runId, bucket);
  }
  const fallbackTime = timestamp(task.createdAt) ?? 0;
  const all: CollaborationRun[] = [
    ...new Set([...persisted.keys(), ...Object.keys(session.runsById)]),
  ]
    .map((id) => {
      const saved = persisted.get(id);
      const node = session.runsById[id];
      const events = byRun.get(id) ?? [];
      const start = events.find((record) => record.event.type === "run_started");
      const end = events.findLast((record) => record.event.type === "run_ended");
      const terminal = saved && !isRunActive(saved.status) ? saved.status : undefined;
      let status: CollaborationStatus =
        end?.event.type === "run_ended"
          ? end.event.status
          : (terminal ?? node?.runStatus ?? saved?.status ?? "queued");
      const waiting = node?.steps.some(
        (step) => step.kind === "approval" && pendingApprovalIds.has(step.approvalId),
      );
      if (waiting && isRunActive(status)) status = "waiting";
      const tools = node?.steps.filter((step) => step.kind === "tool") ?? [];
      const startedAt =
        timestamp(saved?.startedAt) ??
        timestamp(start?.createdAt) ??
        timestamp(saved?.createdAt) ??
        timestamp(events[0]?.createdAt) ??
        fallbackTime;
      return {
        id,
        parentId: saved?.parentRunId ?? node?.parentRunId ?? null,
        agent: saved?.agent ?? node?.agent ?? "orchestrator",
        title: saved?.input?.userMessage || (node?.parentRunId ? "委派任务" : task.goal),
        status,
        startedAt,
        endedAt: isRunActive(status)
          ? null
          : Math.max(
              startedAt,
              timestamp(end?.createdAt) ??
                timestamp(saved?.endedAt) ??
                timestamp(events.at(-1)?.createdAt) ??
                timestamp(task.updatedAt) ??
                startedAt,
            ),
        result: node?.text || saved?.resultText || "",
        error:
          (end?.event.type === "run_ended" ? end.event.error : undefined) ??
          node?.error ??
          saved?.resultError ??
          null,
        toolCount: tools.length,
        currentTool: isRunActive(status)
          ? (tools.findLast((step) => !step.done)?.name ?? null)
          : null,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const index = new Map(all.map((run) => [run.id, run]));
  const rootOf = (id: string): string => {
    const visited = new Set<string>();
    let current = index.get(id);
    while (current?.parentId && index.has(current.parentId) && !visited.has(current.parentId)) {
      visited.add(current.id);
      current = index.get(current.parentId);
    }
    return current?.id ?? id;
  };
  const roots = all.filter((run) => !run.parentId || !index.has(run.parentId));
  const selectedRoot =
    roots.find((run) => run.id === rootId) ??
    roots.find((run) => run.id === rootOf(task.currentRunId ?? "")) ??
    roots.at(-1) ??
    null;
  const selectedRuns = selectedRoot ? all.filter((run) => rootOf(run.id) === selectedRoot.id) : [];
  const selectedIds = new Set(selectedRuns.map((run) => run.id));
  const scopedRecords = records.filter((record) => selectedIds.has(record.runId));
  const latestRecordAt = scopedRecords.reduce(
    (latest, record) => Math.max(latest, timestamp(record.createdAt) ?? 0),
    selectedRoot?.startedAt ?? fallbackTime,
  );
  // 根运行已停止时，不把缺少结束事件的子运行显示为仍在执行。
  const rootEndedAt =
    selectedRoot && !isRunActive(selectedRoot.status) ? selectedRoot.endedAt : null;
  const nodes = selectedRuns.map((run) =>
    rootEndedAt !== null && isRunActive(run.status)
      ? {
          ...run,
          status: selectedRoot?.status === "failed" ? ("failed" as const) : ("cancelled" as const),
          endedAt: Math.max(run.startedAt, rootEndedAt),
          currentTool: null,
        }
      : run,
  );
  const root = nodes.find((run) => run.id === selectedRoot?.id) ?? null;
  const members = nodes.filter((run) => run.id !== root?.id);
  const outputMap = new Map<string, CollaborationOutput>();
  for (const record of scopedRecords) {
    if (record.event.type !== "file_change") continue;
    const path = record.event.change.path;
    outputMap.set(path, {
      id: `change:${path}`,
      title: path.replace(/\\/g, "/").split("/").at(-1) ?? path,
      path,
      runId: record.runId,
      kind: "change",
      createdAt: timestamp(record.createdAt) ?? fallbackTime,
    });
  }
  for (const artifact of [...artifacts].sort((a, b) => a.version - b.version)) {
    if (!artifact.runId || !selectedIds.has(artifact.runId)) continue;
    outputMap.set(
      artifact.filePath ?? artifact.artifactKey ?? `${artifact.kind}:${artifact.title}`,
      {
        id: artifact.id,
        title: artifact.title,
        path: artifact.filePath,
        runId: artifact.runId,
        kind: "artifact",
        createdAt: timestamp(artifact.createdAt) ?? fallbackTime,
      },
    );
  }
  const events = scopedRecords
    .filter((record) =>
      [
        "run_started",
        "run_ended",
        "tool_call",
        "approval_required",
        "artifact_ready",
        "error",
      ].includes(record.event.type),
    )
    .slice(-5)
    .reverse();
  const startedAt = root?.startedAt ?? fallbackTime;
  const endedAt = nodes.reduce(
    (latest, run) => Math.max(latest, run.endedAt ?? run.startedAt),
    latestRecordAt,
  );
  return {
    roots,
    root,
    members,
    nodes,
    events,
    outputs: [...outputMap.values()].sort((a, b) => b.createdAt - a.createdAt),
    startedAt,
    endedAt,
    live: nodes.some((run) => isRunActive(run.status)),
    completed: members.filter((run) => run.status === "succeeded").length,
  };
}

export function formatRunDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

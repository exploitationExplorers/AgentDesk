import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { SqliteTaskPersistence } from "../src/services/storage/sqlite-task-persistence";
const handle = openDatabase(":memory:");
const persistence = new SqliteTaskPersistence(handle);
afterEach(() => handle.raw.exec("DELETE FROM documents; DELETE FROM run_events"));
it("keeps local async transactions isolated and rolls back events with task changes", async () => {
  const now = new Date().toISOString();
  const task = {
    id: "task",
    title: "task",
    goal: "goal",
    agent: null,
    conversationId: "conversation",
    requiresPlanApproval: false,
    status: "pending" as const,
    currentRunId: null,
    pendingApprovalId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = persistence.transaction(async () => {
    await persistence.tasks.put(task);
    await persistence.events.append({
      taskId: task.id,
      runId: "run",
      parentRunId: null,
      event: { type: "task_status", status: "queued" },
      createdAt: now,
    });
    enter();
    await gate;
    throw new Error("rollback");
  });
  await entered;
  const read = persistence.tasks.get(task.id);
  release();
  await expect(transaction).rejects.toThrow("rollback");
  expect(await read).toBeUndefined();
  expect(await persistence.events.read({ taskId: task.id, after: 0, limit: 100 })).toEqual([]);
});

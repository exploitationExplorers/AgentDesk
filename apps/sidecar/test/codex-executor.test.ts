import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexNotification, CodexRpc, CodexServerRequest } from "@agentdesk/integrations";
import type { Run, Task } from "@agentdesk/shared";
import type { CloudRunnerService } from "../src/services/remote/runner";
import type { ApprovalService } from "../src/services/approvals";
import type { TaskService } from "../src/services/tasks";
import { CodexExecutorService, changesInsideWorkspace } from "../src/services/executors/codex";

const opened = vi.hoisted(() => vi.fn());
vi.mock("@agentdesk/integrations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openCodexAppServer: opened,
}));

let root: string, workspace: string, db: Database.Database, service: CodexExecutorService;
let listeners: Set<(event: CodexNotification) => void>, failures: Set<(error: Error) => void>;
let rpc: {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  subscribe: (fn: (e: CodexNotification) => void) => () => void;
  onFailure: (fn: (e: Error) => void) => () => void;
  onRequest: (r: CodexServerRequest) => Promise<unknown>;
};
let tasks: { appendEvent: ReturnType<typeof vi.fn>; recordArtifact: ReturnType<typeof vi.fn> };
let approvals: { request: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
let runner: {
  resolveWorkspace: ReturnType<typeof vi.fn>;
  context: ReturnType<typeof vi.fn>;
  authorizeRun: ReturnType<typeof vi.fn>;
  requiresPlan: ReturnType<typeof vi.fn>;
  bindApproval: ReturnType<typeof vi.fn>;
};
let start: (id: string) => Promise<unknown>;
const run = {
  id: "run-1",
  agent: "code",
  input: { userMessage: "Update README" },
  trigger: "user",
  parentRunId: null,
} as unknown as Run;
const task = { id: "task-1", title: "Test", conversationId: null } as unknown as Task;
const notify = (method: string, params: Record<string, unknown>) => {
  for (const listener of listeners)
    listener({ method, params: { threadId: "thread-1", ...params } });
};
const finish = (id = "turn-1", text = "Done") => {
  notify("item/completed", { turnId: id, item: { id: "message-1", type: "agentMessage", text } });
  notify("turn/completed", { turn: { id, status: "completed" } });
};
const approve = (method: string, itemId: string, extra = {}) =>
  rpc.onRequest({
    id: 1,
    method,
    params: { threadId: "thread-1", turnId: "turn-1", itemId, ...extra },
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-codex-unit-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE codex_threads(task_id TEXT PRIMARY KEY,thread_id TEXT UNIQUE); CREATE TABLE codex_turns(run_id TEXT PRIMARY KEY,thread_id TEXT,turn_id TEXT,status TEXT)",
  );
  listeners = new Set();
  failures = new Set();
  start = async (id) => {
    notify("turn/started", { turn: { id } });
    finish(id);
    return { turn: { id } };
  };
  rpc = {
    request: vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/read" || method === "thread/resume")
        return { thread: { id: "thread-1", cwd: workspace, status: { type: "idle" } } };
      if (method === "turn/start") return start("turn-1");
      return {};
    }),
    close: vi.fn(async () => {
      for (const callback of failures) callback(new Error("closed"));
    }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onFailure: (fn) => {
      failures.add(fn);
      return () => {
        failures.delete(fn);
      };
    },
    onRequest: async () => ({}),
  };
  opened.mockResolvedValue(rpc as unknown as CodexRpc);
  tasks = { appendEvent: vi.fn(), recordArtifact: vi.fn(() => ({ id: "artifact-1", version: 1 })) };
  approvals = {
    request: vi.fn(async () => true),
    create: vi.fn(() => ({ approval: { id: "plan-approval" } })),
  };
  runner = {
    resolveWorkspace: vi.fn(async () => workspace),
    context: vi.fn(() => ({})),
    authorizeRun: vi.fn(),
    requiresPlan: vi.fn(() => false),
    bindApproval: vi.fn(),
  };
  service = new CodexExecutorService(
    db,
    root,
    runner as unknown as CloudRunnerService,
    approvals as unknown as ApprovalService,
    () => tasks as unknown as TaskService,
    "codex-test",
  );
});
afterEach(async () => {
  await service.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Codex task protocol", () => {
  it("handles completion and text arriving before turn/start returns, and reuses a loaded thread", async () => {
    expect(await service.execute(run, task, new AbortController().signal)).toMatchObject({
      status: "succeeded",
      resultText: "Done",
    });
    expect(db.prepare("SELECT status FROM codex_turns").get()).toEqual({ status: "completed" });
    expect(
      await service.execute({ ...run, id: "run-2" }, task, new AbortController().signal),
    ).toMatchObject({ status: "succeeded" });
    expect(rpc.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(rpc.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(0);
  });
  it("binds command approval to the turn even before its start response, and checks authority again", async () => {
    start = async (id) => {
      notify("turn/started", { turn: { id } });
      expect(
        await approve("item/commandExecution/requestApproval", "cmd-1", {
          command: "git status",
          cwd: workspace,
        }),
      ).toEqual({ decision: "accept" });
      finish(id);
      return { turn: { id } };
    };
    expect(await service.execute(run, task, new AbortController().signal)).toMatchObject({
      status: "succeeded",
    });
    expect(approvals.request).toHaveBeenCalledOnce();
    expect(approvals.request.mock.calls[0]?.[0]).toMatchObject({
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1" },
    });
    expect(runner.authorizeRun.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("rejects file escapes, session-wide grants and plan writes without creating approvals", async () => {
    runner.requiresPlan.mockReturnValue(true);
    start = async (id) => {
      notify("turn/started", { turn: { id } });
      notify("item/started", {
        turnId: id,
        item: {
          id: "file-1",
          type: "fileChange",
          changes: [{ path: "../secret.txt", kind: { type: "add" } }],
        },
      });
      expect(await approve("item/fileChange/requestApproval", "file-1")).toEqual({
        decision: "decline",
      });
      expect(
        await approve("item/commandExecution/requestApproval", "cmd-1", {
          command: "echo x",
          cwd: workspace,
          grantRoot: workspace,
        }),
      ).toEqual({ decision: "decline" });
      finish(id, "Plan only");
      return { turn: { id } };
    };
    expect(await service.execute(run, task, new AbortController().signal)).toMatchObject({
      nextTaskStatus: "awaiting_plan_approval",
    });
    expect(approvals.request).not.toHaveBeenCalled();
  });
  it("stops the process after an ambiguous turn/start failure and never retries the write", async () => {
    start = async () => {
      throw new Error("response lost");
    };
    expect(await service.execute(run, task, new AbortController().signal)).toMatchObject({
      status: "failed",
    });
    expect(rpc.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status FROM codex_turns").get()).toEqual({ status: "interrupted" });
  });
  it("cancels pending approvals and the independent process tree when the lease signal aborts", async () => {
    const abort = new AbortController();
    let approvalSignal: AbortSignal | undefined;
    approvals.request.mockImplementation(async (_draft: unknown, signal: AbortSignal) => {
      approvalSignal = signal;
      abort.abort();
      return false;
    });
    start = async (id) => {
      notify("turn/started", { turn: { id } });
      await approve("item/commandExecution/requestApproval", "cmd-1", {
        command: "echo x",
        cwd: workspace,
      });
      return { turn: { id } };
    };
    expect(await service.execute(run, task, abort.signal)).toMatchObject({ status: "cancelled" });
    expect(approvalSignal?.aborted).toBe(true);
    expect(rpc.close).toHaveBeenCalledOnce();
  });
  it("rejects concurrent runs and does not change an already active thread", async () => {
    db.prepare("INSERT INTO codex_threads VALUES(?,?)").run(task.id, "thread-1");
    rpc.request.mockResolvedValue({
      thread: { id: "thread-1", cwd: workspace, status: { type: "active" } },
    });
    await expect(service.execute(run, task, new AbortController().signal)).rejects.toThrow(
      "active turn",
    );
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  });
  it("validates destination paths, rename targets, metadata and symlink escapes", async () => {
    writeFileSync(join(workspace, "README.md"), "x");
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(workspace, "link"), "junction");
    expect(
      await changesInsideWorkspace(workspace, [
        { path: "README.md", kind: { type: "update", move_path: null } },
      ]),
    ).toBe(true);
    for (const path of ["../secret.txt", ".git/config", "link/new.txt"])
      expect(await changesInsideWorkspace(workspace, [{ path, kind: { type: "add" } }])).toBe(
        false,
      );
    expect(
      await changesInsideWorkspace(workspace, [
        { path: "README.md", kind: { type: "update", move_path: "../outside.txt" } },
      ]),
    ).toBe(false);
  });
});

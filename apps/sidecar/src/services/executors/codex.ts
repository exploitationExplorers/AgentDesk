import { businessDatabase, type BusinessDatabase } from "../../db/business-database";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  CODEX_VERSION,
  openCodexAppServer,
  type CodexRpc,
  type CodexServerRequest,
} from "@agentdesk/integrations";
import { AppError, ErrorCode, type TaskStreamEvent } from "@agentdesk/shared";
import type { ApprovalService } from "../approvals";
import type { CloudRunnerService } from "../remote/runner";
import type { RunExecutor, TaskService } from "../tasks";
interface Thread {
  id: string;
  cwd: string;
  status?: {
    type: string;
  };
  turns?: {
    id: string;
    status: string;
  }[];
}
interface Item {
  id: string;
  type: string;
  text?: string;
  command?: string;
  changes?: unknown[];
  status?: string;
  aggregatedOutput?: string;
}
export class CodexExecutorService {
  private readonly db: BusinessDatabase;
  readonly ready: Promise<void>;
  private rpc: Promise<CodexRpc> | undefined;
  private readonly loaded = new Set<string>();
  private active = false;
  private disposed = false;
  constructor(
    db: Database.Database | BusinessDatabase,
    private readonly dataDir: string,
    private readonly runner: CloudRunnerService,
    private readonly approvals: ApprovalService,
    private readonly tasks: () => TaskService,
    private readonly binary = process.env.AGENTDESK_CODEX_BIN,
  ) {
    this.db = businessDatabase(db);
    this.ready = (async () => {})();
  }
  private connection() {
    if (this.disposed)
      throw new AppError(ErrorCode.ServiceUnavailable, "Codex executor has stopped");
    if (!this.binary)
      throw new AppError(ErrorCode.ServiceUnavailable, "Codex binary has not been configured");
    if (!this.rpc) {
      this.rpc = openCodexAppServer(this.binary, join(this.dataDir, "codex"))
        .then((rpc) => {
          rpc.onFailure(() => {
            this.rpc = undefined;
            this.loaded.clear();
          });
          return rpc;
        })
        .catch((error) => {
          this.rpc = undefined;
          throw error;
        });
    }
    return this.rpc;
  }
  async status() {
    if (!this.binary)
      return {
        id: "codex",
        available: false,
        version: CODEX_VERSION,
        reason: "未配置 Codex 可执行文件",
      };
    try {
      const rpc = await this.connection();
      const result = await rpc.request<{
        account: unknown;
        requiresOpenaiAuth: boolean;
      }>("account/read", { refreshToken: false });
      const authenticated = Boolean(result.account) || !result.requiresOpenaiAuth;
      return {
        id: "codex",
        available: authenticated,
        version: CODEX_VERSION,
        authenticated,
        reason: authenticated ? undefined : "请在此宿主完成 Codex 登录",
      };
    } catch {
      return {
        id: "codex",
        available: false,
        version: CODEX_VERSION,
        reason: "Codex 版本、安装或登录状态检查失败",
      };
    }
  }
  async login() {
    if (this.active) throw new AppError(ErrorCode.Conflict, "请等待当前 Codex 任务结束后登录");
    const result = await (
      await this.connection()
    ).request<{
      type: string;
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }>("account/login/start", { type: "chatgptDeviceCode" });
    const url = new URL(result.verificationUrl);
    if (
      result.type !== "chatgptDeviceCode" ||
      url.protocol !== "https:" ||
      !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new AppError(
        ErrorCode.ServiceUnavailable,
        "Codex did not return a supported device authorization URL",
      );
    return { loginId: result.loginId, verificationUrl: url.href, userCode: result.userCode };
  }
  async dispose() {
    this.disposed = true;
    const rpc = await this.rpc?.catch(() => undefined);
    await rpc?.close();
    this.loaded.clear();
  }
  execute: RunExecutor = async (run, task, signal) => {
    if (this.active)
      throw new AppError(ErrorCode.Conflict, "Codex executor already has an active task");
    this.active = true;
    try {
      return await this.executeRun(run, task, signal);
    } finally {
      this.active = false;
    }
  };
  private executeRun: RunExecutor = async (run, task, signal) => {
    await Promise.resolve();
    const tasks = this.tasks(),
      workspace = await this.runner.resolveWorkspace(await this.runner.context(task.id));
    const rpc = await this.connection();
    const emit = async (event: TaskStreamEvent) =>
      await tasks.appendEvent({
        taskId: task.id,
        runId: run.id,
        parentRunId: run.parentRunId,
        event,
      });
    const planOnly = await this.runner.requiresPlan(task);
    const threadOptions = {
      cwd: workspace,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    };
    const old = (await this.db
      .prepare("SELECT thread_id FROM codex_threads WHERE task_id=?")
      .get(task.id)) as
      | {
          thread_id: string;
        }
      | undefined;
    signal.throwIfAborted();
    await this.runner.authorizeRun(run);
    if (old) {
      const current = await rpc.request<{
        thread: Thread;
      }>("thread/read", {
        threadId: old.thread_id,
        includeTurns: false,
      });
      if (current.thread.status?.type === "active")
        throw new AppError(ErrorCode.Conflict, "Codex thread still has an active turn");
      if (resolve(current.thread.cwd) !== resolve(workspace))
        throw new AppError(ErrorCode.Forbidden, "Codex thread workspace differs from this task");
    }
    const alreadyLoaded = old && this.loaded.has(old.thread_id);
    const response = await rpc.request<{
      thread: Thread;
    }>(
      alreadyLoaded ? "thread/read" : old ? "thread/resume" : "thread/start",
      alreadyLoaded
        ? { threadId: old.thread_id, includeTurns: false }
        : old
          ? { threadId: old.thread_id, excludeTurns: true, ...threadOptions }
          : threadOptions,
    );
    if (resolve(response.thread.cwd) !== resolve(workspace))
      throw new AppError(ErrorCode.Forbidden, "Codex thread workspace differs from this task");
    if (
      response.thread.status?.type === "active" ||
      response.thread.turns?.some((turn) => turn.status === "inProgress")
    )
      throw new AppError(ErrorCode.Conflict, "Codex thread still has an active turn");
    const threadId = response.thread.id;
    this.loaded.add(threadId);
    await this.db
      .prepare(
        "INSERT INTO codex_threads(task_id,thread_id) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id",
      )
      .run(task.id, threadId);
    const items = new Map<string, Item>();
    const messageText = new Map<string, string>();
    let text = "",
      diff = "",
      turnId = "",
      settled = false;
    let finish!: (status: string) => void, reject!: (error: Error) => void;
    const completed = new Promise<string>((res, rej) => {
      finish = res;
      reject = rej;
    });
    const approvalAbort = new AbortController();
    const approvalSignal = AbortSignal.any([signal, approvalAbort.signal]);
    // 立即注册 rejection handler，turn/start 等待期间的断连也不会产生未处理 rejection。
    void completed.catch(() => undefined);
    const terminate = (error: Error) => {
      approvalAbort.abort();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const unsubscribeFailure = rpc.onFailure(terminate);
    let eventQueue = Promise.resolve();
    let pendingEvents = 0,
      pendingBytes = 0;
    const handleNotification: Parameters<CodexRpc["subscribe"]>[0] = async (event) => {
      if (event.params.threadId !== threadId) return;
      if (event.method === "turn/started") {
        const turn = event.params.turn as
          | {
              id?: string;
            }
          | undefined;
        if (typeof turn?.id === "string" && !turnId) turnId = turn.id;
      }
      if (!turnId) return;
      if (event.params.turnId && turnId && event.params.turnId !== turnId) return;
      if (event.method === "item/agentMessage/delta" && typeof event.params.delta === "string") {
        if (text.length + event.params.delta.length > 2 * 1024 * 1024) {
          terminate(new Error("Codex output exceeds task limit"));
          return;
        }
        const id = String(event.params.itemId);
        messageText.set(id, (messageText.get(id) ?? "") + event.params.delta);
        text += event.params.delta;
        await emit({ type: "text_delta", agent: run.agent, delta: event.params.delta });
      }
      if (event.method === "turn/diff/updated" && typeof event.params.diff === "string")
        diff = event.params.diff.slice(0, 2 * 1024 * 1024);
      if (event.method === "item/started" || event.method === "item/completed") {
        const item = event.params.item as Item;
        if (!item || typeof item.id !== "string") return;
        items.set(item.id, item);
        if (
          event.method === "item/completed" &&
          item.type === "agentMessage" &&
          typeof item.text === "string"
        ) {
          const previous = messageText.get(item.id) ?? "";
          if (item.text.startsWith(previous)) {
            const delta = item.text.slice(previous.length);
            if (text.length + delta.length > 2 * 1024 * 1024) {
              terminate(new Error("Codex output exceeds task limit"));
              return;
            }
            text += delta;
            messageText.set(item.id, item.text);
            if (delta) await emit({ type: "text_delta", agent: run.agent, delta });
          }
        }
        if (item.type === "commandExecution" || item.type === "fileChange") {
          if (event.method === "item/started")
            await emit({
              type: "tool_call",
              agent: run.agent,
              id: item.id,
              name: `codex.${item.type}`,
              args: { command: item.command, changes: item.changes },
            });
          else
            await emit({
              type: "tool_result",
              agent: run.agent,
              id: item.id,
              result: { status: item.status, output: item.aggregatedOutput?.slice(0, 65536) },
              isError: item.status === "failed",
            });
        }
      }
      if (event.method === "turn/completed") {
        const turn = event.params.turn as {
          id?: string;
          status?: string;
        };
        if (turnId && turn.id !== turnId) return;
        if (!settled) {
          settled = true;
          finish(turn.status ?? "failed");
        }
      }
    };
    const unsubscribe = rpc.subscribe((event) => {
      const bytes = JSON.stringify(event).length * 2;
      if (pendingEvents >= 4096 || pendingBytes + bytes > 8 * 1024 * 1024) {
        terminate(new Error("Codex event persistence queue exceeded its capacity"));
        return;
      }
      pendingEvents++;
      pendingBytes += bytes;
      eventQueue = eventQueue
        .then(async () => {
          if (!settled) await handleNotification(event);
        })
        .catch((error) =>
          terminate(error instanceof Error ? error : new Error("Codex event persistence failed")),
        )
        .finally(() => {
          pendingEvents--;
          pendingBytes -= bytes;
        });
    });
    rpc.onRequest = async (request: CodexServerRequest) => {
      await eventQueue;
      if (
        request.params.threadId !== threadId ||
        !turnId ||
        request.params.turnId !== turnId ||
        signal.aborted
      )
        return { decision: "cancel" };
      await this.runner.authorizeRun(run);
      const file = request.method === "item/fileChange/requestApproval",
        command = request.method === "item/commandExecution/requestApproval";
      if (!file && !command) throw new Error("Unsupported approval type");
      if (planOnly || request.params.grantRoot) return { decision: "decline" };
      if (
        command &&
        (!request.params.command ||
          typeof request.params.cwd !== "string" ||
          resolve(request.params.cwd) !== resolve(workspace))
      )
        return { decision: "decline" };
      const item = items.get(String(request.params.itemId));
      if (
        file &&
        (!item?.changes?.length || !(await changesInsideWorkspace(workspace, item.changes)))
      )
        return { decision: "decline" };
      const detail = file ? JSON.stringify(item!.changes) : String(request.params.command);
      const approved = await this.approvals.request(
        {
          kind: "tool",
          conversationId: task.conversationId,
          title: file ? "Codex 文件修改" : "Codex 命令执行",
          detail,
          risk: "confirm",
          payload: {
            executor: "codex",
            threadId,
            turnId,
            itemId: request.params.itemId,
            requestId: request.id,
            detail,
          },
        },
        approvalSignal,
        async (approval) => {
          await this.runner.bindApproval(approval, task);
          await emit({
            type: "approval_required",
            approvalId: approval.id,
            title: approval.title,
            detail: approval.detail,
            risk: approval.risk,
            payload: approval.payload,
          });
        },
      );
      await this.runner.authorizeRun(run);
      signal.throwIfAborted();
      return { decision: approved ? "accept" : "decline" };
    };
    const abort = () => {
      terminate(new Error("Codex task interrupted"));
      if (turnId)
        void rpc.request("turn/interrupt", { threadId, turnId }, 5000).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await emit({
        type: "run_started",
        runId: run.id,
        parentRunId: run.parentRunId,
        agent: run.agent,
        trigger: run.trigger,
      });
      // 发起前落库；回包丢失不自动重试 turn/start。
      await this.db
        .prepare("INSERT INTO codex_turns(run_id,thread_id,status) VALUES(?,?,'starting')")
        .run(run.id, threadId);
      const started = await rpc.request<{
        turn: {
          id: string;
        };
      }>("turn/start", {
        threadId,
        clientUserMessageId: run.id,
        input: [
          {
            type: "text",
            text: planOnly
              ? `${run.input.userMessage}\n\n仅分析并输出可审阅方案；禁止修改文件或执行有副作用的操作。`
              : run.input.userMessage,
            text_elements: [],
          },
        ],
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      if (turnId && turnId !== started.turn.id) throw new Error("Codex turn identity changed");
      turnId = started.turn.id;
      await this.db
        .prepare("UPDATE codex_turns SET turn_id=?,status='running' WHERE run_id=?")
        .run(turnId, run.id);
      if (signal.aborted) abort();
      const status = await completed;
      await this.runner.authorizeRun(run);
      signal.throwIfAborted();
      await this.db.prepare("UPDATE codex_turns SET status=? WHERE run_id=?").run(status, run.id);
      if (status !== "completed")
        return {
          status: status === "interrupted" ? "cancelled" : "failed",
          resultError: "Codex turn did not complete",
        };
      if (diff)
        await tasks.recordArtifact({
          taskId: task.id,
          runId: run.id,
          kind: "change",
          title: "Codex changes",
          content: diff,
        });
      if (planOnly) {
        const plan = await tasks.recordArtifact({
          taskId: task.id,
          runId: run.id,
          kind: "plan",
          title: "Codex plan",
          content: text,
        });
        const approval = (
          await this.approvals.create({
            kind: "plan",
            title: `方案待批准：${task.title}`,
            detail: text,
            risk: "confirm",
            payload: { taskId: task.id, artifactId: plan.id, version: plan.version },
          })
        ).approval;
        await this.runner.bindApproval(approval, task);
        await emit({ type: "plan_updated", artifactId: plan.id, version: plan.version });
        return { status: "succeeded", resultText: text, nextTaskStatus: "awaiting_plan_approval" };
      }
      return { status: "succeeded", resultText: text };
    } catch {
      await this.db
        .prepare(
          "UPDATE codex_turns SET status='interrupted' WHERE run_id=? AND status IN ('starting','running')",
        )
        .run(run.id);
      // 停止整个独立 app-server 子树，避免断线／撤销后后台继续写入。
      await rpc.close();
      this.rpc = undefined;
      return {
        status: signal.aborted ? "cancelled" : "failed",
        resultError: "Codex interrupted; inspect the persisted changes before explicitly resuming",
      };
    } finally {
      approvalAbort.abort();
      signal.removeEventListener("abort", abort);
      unsubscribe();
      unsubscribeFailure();
      rpc.onRequest = async () => {
        throw new Error("No active task");
      };
    }
  };
}
/** 文件审批中的路径和移动目标必须落在当前工作区，现有符号链接也不能越界。 */
export async function changesInsideWorkspace(
  workspace: string,
  changes: unknown[],
): Promise<boolean> {
  const root = await realpath(workspace);
  const inside = (path: string) => {
    const rel = relative(root, path);
    return (
      !!rel &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !rel.split(sep).some((part) => part.toLowerCase() === ".git")
    );
  };
  for (const value of changes) {
    if (!value || typeof value !== "object") return false;
    const change = value as {
      path?: unknown;
      kind?: {
        type?: unknown;
        move_path?: unknown;
      };
    };
    if (!change.kind || !["add", "delete", "update"].includes(String(change.kind.type)))
      return false;
    const paths = [change.path, ...(change.kind.move_path == null ? [] : [change.kind.move_path])];
    for (const path of paths) {
      if (typeof path !== "string" || !path || path.includes("\0")) return false;
      const target = resolve(root, path);
      if (!inside(target)) return false;
      let parent = target;
      for (;;) {
        try {
          const canonical = await realpath(parent);
          if (canonical !== root && !inside(canonical)) return false;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
          const next = dirname(parent);
          if (next === parent) return false;
          parent = next;
        }
      }
    }
  }
  return changes.length > 0;
}

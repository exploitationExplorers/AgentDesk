import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  startAutoloopRuntime,
  type AutoloopRuntime,
  type AutoloopRuntimeOptions,
} from "@agentdesk/autoloop-runtime";
import {
  AutoloopClient,
  AutoloopClientError,
  validateWorkspacePath,
  type HubResult,
  type HubJob,
} from "@agentdesk/integrations";
import {
  AppError,
  ErrorCode,
  AutomationBindingInput,
  type AutomationBinding,
  type AutoloopStatus,
  type AutoloopInteractionAnswer,
  type Conversation,
} from "@agentdesk/shared";
import {
  DurableCheckpointError,
  DurableModelError,
  type DurableAgentOptions,
} from "@agentdesk/agent-core";
import type { SecretStore } from "../../secrets";
import type { TaskService } from "../tasks";
import { Collection } from "../../db/collection";
import { newId, nowIso } from "../../util";
import { type AutoloopStore, stableId, type OutboxCommand, type RunLink } from "./store";
import { projectFact } from "./projection";
import { executeAutomation, type AutomationExecutorDeps } from "./executor";
import { settleReceipt } from "./receipts";
import { ConversationStore } from "../conversation-store";
import { suspensionTimer } from "./timers";
import { checkpointUsage } from "./budgets";

interface ServiceDeps extends Omit<AutomationExecutorDeps, "store"> {
  store: AutoloopStore;
  secrets: SecretStore;
  dataDir: string;
  runtimeFactory?: (options: AutoloopRuntimeOptions) => Promise<AutoloopRuntime>;
  fetchImpl?: typeof fetch;
}
export class AutoloopService {
  private runtime?: AutoloopRuntime;
  private client?: AutoloopClient;
  private startup?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private stream?: Promise<void>;
  private ticking = false;
  private tickFinished: Promise<void> = Promise.resolve();
  private closing = false;
  private active?: { link: RunLink; controller: AbortController; promise: Promise<void> };
  private sending = new Map<string, Promise<OutboxCommand>>();
  private configTail: Promise<unknown> = Promise.resolve();
  private health: "unknown" | "healthy" | "degraded" | "unavailable" = "unknown";
  private syncedAt: string | null = null;
  private readonly store: AutoloopStore;
  private readonly tasks: TaskService;
  constructor(private readonly deps: ServiceDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
  }
  status(): AutoloopStatus {
    return {
      available: this.health === "healthy",
      mode: this.runtime ? "local" : "disabled",
      protocolVersion: this.runtime ? "v1" : null,
      lastSyncedAt: this.syncedAt,
      connections: this.runtime
        ? [
            {
              id: "local",
              hubId: "local",
              health: this.health,
              protocolVersion: "v1",
              lastSyncedAt: this.syncedAt,
            },
          ]
        : [],
    };
  }
  listBindings() {
    return this.store.bindings.list();
  }
  getBinding(id: string) {
    return this.store.bindings.get(id);
  }
  listTasks(id: string) {
    return this.tasks.list().filter((t) => t.automationId === id);
  }
  listInteractions(taskId?: string) {
    return this.store.cards.list().filter((c) => !taskId || c.taskId === taskId);
  }
  async start(): Promise<void> {
    if (this.listBindings().length) await this.ensureRuntime();
  }

  private rules(bindings = this.listBindings()) {
    const scheduled = bindings.find((b) => b.enabled && b.schedule);
    return {
      timezone: scheduled?.schedule?.timezone ?? "Asia/Shanghai",
      sources: { agentdesk: { name: "AgentDesk" } },
      agents: {
        agentdesk: { name: "AgentDesk", worker: "agentdesk", use: "agentdesk", access: "edit" },
      },
      channels: {},
      rules: bindings.flatMap((b) => {
        const base = {
          name: b.ruleName,
          to: "agentdesk",
          cwd: b.workspacePolicy.root,
          prompt: b.goal,
          group: b.id,
          parallel: 1,
          tell: "never",
        };
        return [
          {
            ...base,
            when: {
              source: "agentdesk",
              types: [b.enabled ? eventType(b) : `disabled.${b.id.replaceAll("-", "")}`],
            },
          },
          ...(b.schedule
            ? [
                {
                  ...base,
                  name: `${b.ruleName}-schedule`,
                  when: b.enabled
                    ? { cron: b.schedule.cron }
                    : {
                        source: "agentdesk",
                        types: [`disabled.schedule.${b.id.replaceAll("-", "")}`],
                      },
                },
              ]
            : []),
        ];
      }),
    };
  }
  private ensureRuntime(): Promise<void> {
    if (this.closing) throw new AppError(ErrorCode.Conflict, "自动化服务正在退出");
    if (this.client) return Promise.resolve();
    return (this.startup ??= (async () => {
      const credentials = {
        owner: this.credential("owner"),
        worker: this.credential("worker"),
        source: this.credential("source"),
      };
      this.runtime = await (this.deps.runtimeFactory ?? startAutoloopRuntime)({
        dataDir: join(this.deps.dataDir, "autoloop"),
        rules: this.rules(),
        credentials,
        signal: this.controller.signal,
      });
      this.store.acquireEpoch();
      this.client = new AutoloopClient({
        baseUrl: this.runtime.baseUrl,
        credentials,
        fetchImpl: this.deps.fetchImpl,
      });
      await this.client.health();
      this.health = "healthy";
      this.stream = this.observe();
      this.timer = setInterval(() => {
        void this.tick();
      }, 1000);
      this.timer.unref();
      await this.tick();
    })().catch(async (error: unknown) => {
      this.health = "unavailable";
      this.client = undefined;
      await this.runtime?.stop();
      this.runtime = undefined;
      this.startup = undefined;
      throw error;
    }));
  }
  private credential(role: string): string {
    const id = `autoloop:local:${role}`;
    let value = this.deps.secrets.get(id);
    if (!value) {
      value = randomBytes(32).toString("base64url");
      this.deps.secrets.set(id, value);
    }
    return value;
  }
  private configure<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.configTail.then(operation);
    this.configTail = next.catch(() => {});
    return next;
  }
  createBinding(raw: AutomationBindingInput): Promise<AutomationBinding> {
    return this.configure(async () => {
      const input = AutomationBindingInput.parse(raw);
      let root: string;
      try {
        root = validateWorkspacePath(input.workspacePolicy.root);
      } catch {
        throw new AppError(ErrorCode.BadRequest, "工作区必须是合法的本机绝对路径");
      }
      await this.deps.projectInstructions.validateWorkspace(root);
      if (
        input.projectId &&
        this.deps.projects.get(input.projectId).path.toLowerCase() !== root.toLowerCase()
      )
        throw new AppError(ErrorCode.BadRequest, "项目与工作区不一致");
      const timezone = this.listBindings().find((b) => b.enabled && b.schedule)?.schedule?.timezone;
      if (input.schedule && timezone && input.schedule.timezone !== timezone)
        throw new AppError(ErrorCode.BadRequest, `当前本机自动化使用 ${timezone} 时区`);
      await this.ensureRuntime();
      const id = newId();
      const now = nowIso();
      const binding: AutomationBinding = {
        ...input,
        workspacePolicy: { ...input.workspacePolicy, root },
        id,
        automationId: id,
        hubId: "local",
        ruleName: `agentdesk-${id}`,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      // 先持久化意图，重启按此配置恢复；Hub 明确拒绝时才回滚。
      this.store.bindings.put(binding);
      this.store.workspaces.put({ id, realPath: await realpath(root) });
      try {
        await this.runtime!.updateRules(this.rules());
      } catch {
        this.store.bindings.delete(id);
        throw new AppError(ErrorCode.BadRequest, "自动化规则未生效，请检查定时表达式");
      }
      return binding;
    });
  }
  disableBinding(id: string): Promise<AutomationBinding> {
    return this.configure(async () => {
      await this.ensureRuntime();
      const binding = this.requireBinding(id);
      const next = { ...binding, enabled: false, updatedAt: nowIso() };
      this.store.bindings.put(next);
      await this.runtime!.updateRules(this.rules());
      return next;
    });
  }
  async trigger(id: string, input: { eventId: string }) {
    await this.ensureRuntime();
    const binding = this.requireBinding(id);
    if (!binding.enabled) throw new AppError(ErrorCode.Conflict, "自动化已停用");
    const commandId = stableId("event", id, input.eventId);
    const body = JSON.stringify({
      id: `${id}:${stableId(input.eventId)}`,
      type: eventType(binding),
      subject: stableId(id, input.eventId),
      summary: binding.title,
      detail: binding.goal,
    });
    this.store.enqueue({ id: commandId, operation: "event", body, bindingId: id });
    await this.deliver(commandId);
    void this.tick();
    return { commandId };
  }
  async followupTask(taskId: string, input: { message: string; eventId: string }) {
    await this.ensureRuntime();
    const eventId = stableId("followup", taskId, input.eventId);
    const existing = this.store.followups.get(eventId);
    if (existing) {
      if (existing.message !== input.message)
        throw new AppError(ErrorCode.Conflict, "同一请求不能更换修改内容");
      await this.deliver(existing.commandId);
      return { taskId };
    }
    const task = this.tasks.get(taskId);
    if (!task?.automationId) throw new AppError(ErrorCode.NotFound, "自动化任务不存在");
    if (task.automationStatus !== "completed" || this.store.stopped.get(taskId))
      throw new AppError(ErrorCode.Conflict, "请等待任务完成后再修改");
    if (this.store.followups.list().some((f) => f.taskId === taskId && !f.consumed))
      throw new AppError(ErrorCode.Conflict, "已有待处理的修改请求");
    const binding = this.requireBinding(task.automationId);
    const type = binding.enabled
      ? eventType(binding)
      : `disabled.${binding.id.replaceAll("-", "")}`;
    this.store.db.transaction(() => {
      this.store.followups.put({
        id: eventId,
        taskId,
        message: input.message,
        commandId: eventId,
        consumed: false,
      });
      this.store.enqueue({
        id: eventId,
        operation: "event",
        bindingId: binding.id,
        body: JSON.stringify({
          id: eventId,
          type,
          subject: stableId(taskId),
          summary: binding.title,
          detail: input.message,
        }),
      });
    });
    await this.deliver(eventId);
    void this.tick();
    return { taskId };
  }
  async resumeTask(taskId: string) {
    await this.ensureRuntime();
    const task = this.tasks.get(taskId);
    if (!task?.automationId || this.store.stopped.get(taskId))
      throw new AppError(ErrorCode.Conflict, "已停止的任务不能恢复");
    const checkpoint = this.store.checkpoints.get(taskId)?.checkpoint;
    if (
      checkpoint?.phase === "unknown" ||
      Object.values(checkpoint?.steps ?? {}).some((s) => ["unknown", "started"].includes(s.status))
    )
      throw new AppError(
        ErrorCode.Conflict,
        "已有操作的结果不确定，不能自动重做；请核对文件和产物后创建新任务",
      );
    const link = this.store.links
      .list()
      .find((l) => l.taskId === taskId && l.runId === task.currentRunId);
    if (!link || link.state !== "attention")
      throw new AppError(ErrorCode.Conflict, "当前任务没有可恢复的安全执行点");
    if (this.store.outbox.list().some((c) => c.linkId === link.id && c.status === "conflict"))
      throw new AppError(ErrorCode.Conflict, "执行回执有冲突，请核实后创建新任务");
    this.store.links.put({ ...link, state: "prepared" });
    this.tasks.setAutomationStatus(taskId, "queued");
    void this.tick();
    return { taskId };
  }
  async answerInteraction(id: string, answer: AutoloopInteractionAnswer) {
    await this.ensureRuntime();
    const card = this.store.cards.get(id);
    if (!card) throw new AppError(ErrorCode.NotFound, "问题不存在");
    if (card.kind !== "ask") throw new AppError(ErrorCode.BadRequest, "此卡片不能回答");
    const body = JSON.stringify({
      ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
      ...(answer.text ? { text: answer.text } : {}),
    });
    const key = stableId("answer", id, answer.answerId);
    const commandId = this.store.db.transaction(() => {
      const existing = this.store.answers.get(key);
      if (existing) {
        if (existing.body !== body)
          throw new AppError(ErrorCode.Conflict, "同一回答编号不能提交不同内容");
        return existing.commandId;
      }
      if (card.state !== "open") throw new AppError(ErrorCode.Conflict, "问题已经处理");
      if (card.version !== answer.cardVersion)
        throw new AppError(ErrorCode.Conflict, "问题已更新，请刷新");
      if (answer.choice !== undefined && !card.options[answer.choice])
        throw new AppError(ErrorCode.BadRequest, "选项不存在");
      if (card.taskId && this.store.stopped.get(card.taskId))
        throw new AppError(ErrorCode.Conflict, "自动化已停止");
      if (this.store.answers.list().some((a) => a.cardId === id))
        throw new AppError(ErrorCode.Conflict, "该问题已有待确认的回答");
      this.store.enqueue({ id: key, operation: "answer", body, target: Number(card.remoteCardId) });
      this.store.answers.put({
        id: key,
        cardId: id,
        body,
        commandId: key,
        answerId: answer.answerId,
      });
      return key;
    });
    const sent = await this.deliver(commandId);
    if (sent.status !== "delivered") throw new AppError(ErrorCode.Conflict, "回答尚未确认");
    const latest = this.store.cards.get(id)!;
    const updated = this.store.cards.put({
      ...latest,
      state: latest.state === "done" ? "done" : "answered",
      answerId: answer.answerId,
      answerText: answer.text ?? card.options[answer.choice ?? -1] ?? null,
      updatedAt: nowIso(),
    });
    void this.tick();
    return updated;
  }
  async cancelTask(taskId: string) {
    await this.ensureRuntime();
    const task = this.tasks.get(taskId);
    if (!task?.automationId) throw new AppError(ErrorCode.NotFound, "自动化任务不存在");
    this.store.stopTask(taskId);
    if (this.active?.link.taskId === taskId) this.active.controller.abort();
    // 停止事项同时停用后续定时；保留会话、卡片及产物用于查看。
    await this.disableBinding(task.automationId);
    await this.runtime!.cancelSession(task.conversationId);
    if (this.active?.link.taskId === taskId) await this.active.promise;
    for (const link of this.store.links
      .list()
      .filter((l) => l.taskId === taskId && l.state !== "submitted")) {
      const recorded = this.store.outbox.get(stableId("result", link.id));
      if (recorded) await this.deliver(recorded.id);
      else
        await this.submit(link, {
          outcome: "cancelled",
          session: link.session,
          summary: "任务已停止",
        });
    }
    for (const card of this.listInteractions(taskId).filter((c) => c.state === "open")) {
      const id = stableId("resolve", card.id);
      this.store.enqueue({
        id,
        operation: "resolve",
        target: Number(card.remoteCardId),
        body: JSON.stringify({ reason: "任务已停止" }),
      });
      await this.deliver(id);
    }
    this.tasks.setAutomationStatus(taskId, "cancelled");
    this.store.stoppedSynced.put({ id: taskId });
    return { requested: true };
  }
  private deliver(id: string): Promise<OutboxCommand> {
    const pending = this.sending.get(id);
    if (pending) return pending;
    const promise = this.send(id).finally(() => this.sending.delete(id));
    this.sending.set(id, promise);
    return promise;
  }
  private async send(id: string): Promise<OutboxCommand> {
    this.store.assertEpoch();
    const entry = this.store.outbox.get(id)!;
    if (entry.status === "delivered") {
      settleReceipt(this.store, this.tasks, entry);
      return entry;
    }
    if (entry.status === "conflict")
      throw new AppError(ErrorCode.Conflict, "命令与已接受的结果冲突，需要处理");
    try {
      let response: unknown;
      if (entry.operation === "event") response = await this.client!.sendEvent(entry.body);
      else if (entry.operation === "answer") {
        response = await this.client!.answerCard(entry.target!, entry.body);
        if (!(response as { changed: boolean }).changed) {
          const observed = this.store.interactionKeys.get(String(entry.target!));
          const card =
            observed && (observed.choice !== null || observed.answer !== null)
              ? observed
              : await this.client!.getCard(entry.target!);
          const answer = JSON.parse(entry.body) as { choice?: number; text?: string };
          if (
            !card ||
            card.choice !== (answer.choice ?? null) ||
            card.answer !== (answer.text?.trim() ?? null)
          )
            throw new AppError(ErrorCode.Conflict, "问题已由另一份回答处理或尚无法确认");
        }
      } else if (entry.operation === "resolve") {
        await this.client!.resolveCard(
          entry.target!,
          (JSON.parse(entry.body) as { reason: string }).reason,
        );
        response = { ok: true };
      } else if (entry.operation === "cancel") {
        await this.client!.cancelRun(entry.target!);
        response = { ok: true };
      } else {
        const token = this.deps.secrets.get(`autoloop:run:${entry.linkId}`);
        if (!token) throw new AppError(ErrorCode.Conflict, "运行凭据缺失，需核实执行状态");
        if (entry.operation === "started") {
          await this.client!.started(
            entry.target!,
            token,
            (JSON.parse(entry.body) as { session: string }).session,
          );
          response = { ok: true };
        } else {
          response = await this.client!.result(entry.target!, token, entry.body);
          if ((response as { rejected: unknown[] }).rejected.length)
            throw new AppError(ErrorCode.Conflict, "Hub 拒绝部分回执，请核实任务");
        }
      }
      this.store.assertEpoch();
      this.health = "healthy";
      this.syncedAt = nowIso();
      const delivered = this.store.db.transaction(() => {
        const confirmed = this.store.outbox.put({ ...entry, status: "delivered", response });
        settleReceipt(this.store, this.tasks, confirmed);
        return confirmed;
      });
      if (entry.operation === "answer") {
        const answer = this.store.answers.list().find((a) => a.commandId === entry.id);
        const card = answer ? this.store.cards.get(answer.cardId) : undefined;
        if (card && answer) this.store.cards.put({ ...card, answerId: answer.answerId });
      }
      return delivered;
    } catch (error) {
      if (!this.store.ownsEpoch()) throw error;
      this.health = "degraded";
      if (
        error instanceof AppError ||
        (error instanceof AutoloopClientError && [400, 401, 403, 409].includes(error.status))
      ) {
        this.store.outbox.put({ ...entry, status: "conflict" });
        if (entry.linkId) {
          const link = this.store.links.get(entry.linkId);
          if (link) this.tasks.setAutomationStatus(link.taskId, "needs_attention");
        }
      }
      throw new AppError(
        ErrorCode.IntegrationFailed,
        "后台暂时无法确认操作，已保留记录，请稍后重试",
      );
    }
  }
  private async observe(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        for await (const fact of this.client!.facts(
          this.store.state.get("cursor")?.value ?? 0,
          this.controller.signal,
        ))
          projectFact(this.store, this.tasks, fact);
      } catch {
        if (!this.controller.signal.aborted) this.health = "degraded";
      }
      if (!this.controller.signal.aborted) await delay(1000, this.controller.signal);
    }
  }
  async tick(): Promise<void> {
    if (this.ticking || !this.client || this.closing) return;
    this.ticking = true;
    let finishTick!: () => void;
    this.tickFinished = new Promise((resolve) => {
      finishTick = resolve;
    });
    let slot: (() => void) | undefined;
    try {
      this.store.assertEpoch();
      for (const stopped of this.store.stopped.list()) {
        if (this.store.stoppedSynced.get(stopped.id) || this.active?.link.taskId === stopped.id)
          continue;
        const task = this.tasks.get(stopped.id);
        if (!task) continue;
        await this.runtime!.cancelSession(task.conversationId);
        const pending = this.store.links
          .list()
          .filter((l) => l.taskId === task.id && l.state !== "submitted");
        for (const link of pending) {
          const recorded = this.store.outbox.get(stableId("result", link.id));
          if (recorded) await this.deliver(recorded.id);
          else
            await this.submit(link, {
              outcome: "cancelled",
              session: link.session,
              summary: "任务已停止",
            });
        }
        if (!this.store.links.list().some((l) => l.taskId === task.id && l.state !== "submitted")) {
          this.tasks.setAutomationStatus(task.id, "cancelled");
          this.store.stoppedSynced.put({ id: task.id });
        }
      }
      for (const entry of this.store.outbox
        .list()
        .filter((e) => e.status === "delivered" && e.operation === "result"))
        settleReceipt(this.store, this.tasks, entry);
      for (const entry of this.store.outbox.list().filter((e) => e.status === "pending")) {
        try {
          await this.deliver(entry.id);
        } catch {
          /* 单条命令的故障不阻塞其他事项。 */
        }
      }
      const active = this.active;
      if (active) {
        const heartbeat = await this.client.work(
          "heartbeat",
          0,
          [active.link.remoteRunId],
          this.controller.signal,
        );
        if (heartbeat.cancel.includes(active.link.remoteRunId)) active.controller.abort();
        return;
      }
      slot = this.tasks.reserveExternalSlot();
      if (!slot) {
        await this.client.work("capacity", 0, [], this.controller.signal);
        return;
      }
      const recoverable = this.store.links
        .list()
        .find(
          (l) =>
            ["prepared", "running"].includes(l.state) &&
            !this.store.outbox.get(stableId("result", l.id)),
        );
      if (recoverable) {
        const token = this.deps.secrets.get(`autoloop:run:${recoverable.id}`);
        if (!token) {
          this.attention(recoverable);
          return;
        }
        const release = slot;
        slot = undefined;
        this.launch(recoverable, { ...recoverable.job, token }, release);
        return;
      }
      const claims = new Collection<{ id: string; claim: string }>(
        this.store.db,
        "autoloop_claim_v1",
      );
      let claim = claims.get("pending");
      if (!claim) {
        claim = { id: "pending", claim: newId() };
        claims.put(claim);
      }
      const response = await this.client.work(claim.claim, 1, [], this.controller.signal);
      this.controller.signal.throwIfAborted();
      if (!response.job) {
        claims.delete("pending");
        return;
      }
      const job = response.job;
      // 凭据先于映射写入；崩溃后相同 claim 可取回工作，不能丢失执行权。
      this.deps.secrets.set(`autoloop:run:${stableId("local", job.run, job.attempt)}`, job.token);
      const link = this.accept(job, claim.claim);
      claims.delete("pending");
      const release = slot;
      slot = undefined;
      this.launch(link, job, release);
    } catch {
      if (!this.closing) this.health = "degraded";
    } finally {
      slot?.();
      this.ticking = false;
      finishTick();
    }
  }
  private launch(link: RunLink, job: HubJob, release: () => void): void {
    const controller = new AbortController();
    const promise = this.execute(link, job, controller.signal).finally(() => {
      release();
      this.active = undefined;
    });
    this.active = { link, controller, promise };
    void promise;
  }
  private attention(link: RunLink, error?: unknown): void {
    this.store.assertEpoch();
    this.store.links.put({ ...link, state: "attention" });
    this.tasks.finalizeRunDirect(link.runId, {
      status: "failed",
      resultError:
        error instanceof AppError
          ? error.message
          : error instanceof DurableCheckpointError
            ? error.cause instanceof AppError
              ? error.cause.message
              : error.message
            : "执行已停止，已有结果已保留，请核实后续操作",
    });
    this.tasks.setAutomationStatus(link.taskId, "needs_attention");
  }
  private accept(job: HubJob, claim: string): RunLink {
    const binding = this.listBindings().find(
      (b) => job.rule.name === b.ruleName || job.rule.name === `${b.ruleName}-schedule`,
    );
    if (!binding) throw new AppError(ErrorCode.Conflict, "Hub 工作没有可信绑定");
    const id = stableId("local", job.run, job.attempt);
    const existing = this.store.links.get(id);
    if (existing) return existing;
    return this.store.db.transaction(() => {
      const followup = this.store.followups
        .list()
        .find((f) => !f.consumed && job.context.events.some((e) => e.id === f.id));
      let task = job.session
        ? this.tasks.findByConversation(job.session)
        : followup
          ? this.tasks.get(followup.taskId)
          : undefined;
      if (job.session && !task)
        throw new AppError(ErrorCode.Conflict, "原会话不存在，不能从头重做");
      if (!task) {
        const conversationId = newId();
        new Collection<Conversation>(this.store.db, "conversations").put({
          id: conversationId,
          title: binding.title,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        task = this.tasks.create({
          goal: binding.goal,
          title: binding.title,
          conversationId,
          requiresPlanApproval: false,
          automationId: binding.id,
        });
        new ConversationStore(this.store.db).insertMessage({
          id: newId(),
          conversationId,
          role: "user",
          agent: null,
          content: binding.goal,
          toolCalls: [],
          createdAt: nowIso(),
        });
      }
      const previous = this.store.links.list().filter((l) => l.taskId === task!.id);
      if (task.automationId !== binding.id)
        throw new AppError(ErrorCode.Conflict, "续办会话与绑定不一致");
      if (followup && !this.store.stopped.get(task.id)) {
        const saved = this.store.checkpoints.get(task.id)?.checkpoint;
        if (!saved || saved.phase !== "completed")
          throw new AppError(ErrorCode.Conflict, "原事项尚未完成，无法追加修改");
        this.store.saveCheckpoint(task.id, {
          ...saved,
          revision: saved.revision + 1,
          phase: "model",
          text: "",
          pendingCalls: [],
          nextToolIndex: 0,
          messages: [
            ...saved.messages,
            { role: "user", content: followup.message, timestamp: Date.now() },
          ],
        });
        new ConversationStore(this.store.db).insertMessage({
          id: newId(),
          conversationId: task.conversationId,
          role: "user",
          agent: null,
          content: followup.message,
          toolCalls: [],
          createdAt: nowIso(),
        });
        this.store.followups.put({ ...followup, consumed: true });
      }
      for (const old of previous) {
        const run = this.tasks.getRun(old.runId);
        if (run && ["queued", "running"].includes(run.status))
          this.tasks.finalizeRunDirect(run.id, {
            status: "failed",
            resultError: "上一轮执行已交由后台恢复核实",
          });
      }
      const run = this.tasks.createRun({
        taskId: task.id,
        kind: "root",
        agent: "orchestrator",
        trigger: job.session ? "resume" : "create",
        executionOwner: "autoloop",
        idempotencyKey: `autoloop:${id}`,
        input: { userMessage: binding.goal, workspace: binding.workspacePolicy.root },
      });
      const { token: _token, ...safeJob } = job;
      return this.store.links.put({
        id,
        bindingId: binding.id,
        remoteRunId: job.run,
        attempt: job.attempt,
        taskId: task.id,
        runId: run.id,
        session: task.conversationId,
        job: safeJob,
        claim,
        state: "prepared",
      });
    });
  }
  private async execute(link: RunLink, job: HubJob, signal: AbortSignal): Promise<void> {
    let began: number | undefined;
    try {
      const binding = this.requireBinding(link.bindingId);
      const run = this.tasks.getRun(link.runId)!;
      const task = this.tasks.get(link.taskId)!;
      const resultId = stableId("result", link.id);
      const recorded = this.store.outbox.get(resultId);
      if (recorded) {
        await this.deliver(resultId);
        return;
      }
      if (link.state === "attention") return;
      const isFollowup = job.context.events.some(
        (e) => this.store.followups.get(e.id)?.taskId === task.id,
      );
      if ((!binding.enabled && !job.session && !isFollowup) || this.store.stopped.get(task.id)) {
        await this.submit(link, {
          outcome: "cancelled",
          session: link.session,
          summary: "任务已停止",
        });
        return;
      }
      const rounds = this.store.links.list().filter((l) => l.taskId === task.id).length;
      if (rounds > binding.maxRounds)
        throw new AppError(ErrorCode.Conflict, "已达到自动化轮次预算");
      const remaining =
        binding.maxMinutes * 60_000 - (this.store.budgets.get(task.id)?.elapsedMs ?? 0);
      if (remaining <= 0) throw new AppError(ErrorCode.Conflict, "已达到自动化执行时长预算");
      const startedId = stableId("started", link.id);
      this.store.enqueue({
        id: startedId,
        operation: "started",
        target: job.run,
        linkId: link.id,
        body: JSON.stringify({ session: link.session }),
      });
      await this.deliver(startedId);
      if (run.status !== "running") this.tasks.startRunDirect(run.id);
      this.tasks.setAutomationStatus(task.id, "running");
      this.store.links.put({ ...link, state: "running" });
      const saved = this.store.checkpoints.get(task.id)?.checkpoint;
      let resume: DurableAgentOptions["resume"];
      if (saved?.suspension) {
        const timer = suspensionTimer(saved.suspension);
        const answered = job.context.answers.find(
          (answer) =>
            this.store.cards
              .list()
              .some(
                (card) => card.remoteCardId === String(answer.card) && card.taskId === task.id,
              ) &&
            this.store.interactionKeys
              .get(String(answer.card))
              ?.key.endsWith(`:${stableId(task.id, saved.suspension!.id)}`),
        );
        if (!answered && !timer) {
          await this.submit(link, this.suspensionResult(link, saved.suspension));
          return;
        }
        if (
          timer &&
          !job.context.timers.some((t) => t.key === stableId(link.taskId, saved.suspension!.id))
        ) {
          await this.submit(link, this.suspensionResult(link, saved.suspension));
          return;
        }
        resume = {
          interactionId: saved.suspension.id,
          value: timer
            ? "时间已到"
            : saved.suspension.kind === "authorization"
              ? answered!.choice === 0
              : [
                  answered!.choice === null ? "" : answered!.options[answered!.choice],
                  answered!.text,
                ]
                  .filter(Boolean)
                  .join("\n"),
        };
      }
      began = Date.now();
      const result = await executeAutomation(
        { ...this.deps, store: this.store },
        binding,
        task,
        run,
        AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(remaining)]),
        resume,
      );
      const receipt: HubResult =
        result.status === "suspended"
          ? this.suspensionResult(link, result.suspension)
          : { outcome: "done", session: link.session, summary: result.text.slice(0, 500) };
      const usage = checkpointUsage(this.store.checkpoints.get(task.id)?.checkpoint);
      const previousUsage = checkpointUsage(saved);
      receipt.usage = {
        ...(usage.tokens !== null && previousUsage.tokens !== null
          ? { tokens: Math.max(0, usage.tokens - previousUsage.tokens) }
          : {}),
        ...(usage.costUsd !== null && previousUsage.costUsd !== null
          ? { cost: Math.max(0, usage.costUsd - previousUsage.costUsd) }
          : {}),
      };
      await this.submit(link, receipt);
    } catch (error) {
      // 退出时保留检查点；回执已经落库时只重试提交，不能重跑 Agent。
      if (this.closing || !this.store.ownsEpoch()) return;
      const recorded = this.store.outbox.get(stableId("result", link.id));
      if (recorded && recorded.status !== "conflict") return;
      if (this.store.stopped.get(link.taskId) || signal.aborted) {
        try {
          await this.submit(link, {
            outcome: "cancelled",
            session: link.session,
            summary: "任务已停止",
          });
        } catch {
          /* 原文回执已经持久化，后台稍后重发。 */
        }
        return;
      }
      if (
        error instanceof DurableModelError &&
        error.cause instanceof Error &&
        /429|5\d\d|timeout|超时|temporar|network|ECONN|fetch failed/i.test(error.cause.message)
      ) {
        try {
          await this.submit(link, {
            outcome: "failed",
            session: link.session,
            error: "模型服务暂时不可用，保留检查点后稍后重试",
          });
        } catch {
          /* 只重发已保存的失败回执，不重跑已完成工具。 */
        }
        return;
      }
      this.attention(link, error);
      // 结果未知不提交 failed，避免 Hub 将可能已产生副作用的步骤自动重跑。
    } finally {
      if (began !== undefined && this.store.ownsEpoch()) {
        const elapsedMs =
          (this.store.budgets.get(link.taskId)?.elapsedMs ?? 0) + Date.now() - began;
        this.store.budgets.put({ id: link.taskId, elapsedMs });
      }
    }
  }
  private suspensionResult(
    link: RunLink,
    suspension: NonNullable<DurableAgentOptions["checkpoint"]>["suspension"],
  ): HubResult {
    if (!suspension) throw new Error("缺少挂起信息");
    const timer = suspensionTimer(suspension);
    if (timer)
      return {
        outcome: "done",
        session: link.session,
        summary: `等待至 ${timer.at}`,
        later: [{ key: stableId(link.taskId, suspension.id), ...timer }],
      };
    const payload = suspension.request.payload as { options?: unknown };
    const provided = Array.isArray(payload?.options)
      ? payload.options.filter((v): v is string => typeof v === "string").slice(0, 5)
      : [];
    const options =
      suspension.kind === "authorization"
        ? ["允许这次操作", "拒绝这次操作"]
        : provided.length >= 2
          ? provided.map((s) => s.slice(0, 200))
          : ["继续当前目标", "需要调整"];
    return {
      outcome: "done",
      session: link.session,
      summary: "等待你确认后继续",
      ask: [
        {
          key: stableId(link.taskId, suspension.id),
          title: suspension.request.title.slice(0, 200),
          text: suspension.request.detail.slice(0, 4000),
          options,
        },
      ],
    };
  }
  private async submit(link: RunLink, result: HubResult): Promise<void> {
    const id = stableId("result", link.id);
    const checkpoint = this.store.checkpoints.get(link.taskId)?.checkpoint;
    const status =
      result.outcome === "failed"
        ? link.attempt >= 10
          ? "needs_attention"
          : "retry_scheduled"
        : result.outcome === "cancelled"
          ? "cancelled"
          : result.later?.length
            ? "waiting_timer"
            : result.ask?.length
              ? checkpoint?.suspension?.kind === "authorization"
                ? "waiting_authorization"
                : "waiting_input"
              : "completed";
    this.store.enqueue({
      id,
      operation: "result",
      target: link.remoteRunId,
      linkId: link.id,
      body: JSON.stringify(result),
      outcome: {
        status,
        text: checkpoint?.text ?? result.summary ?? "",
        toolCalls: checkpoint?.toolCalls ?? [],
      },
    });
    await this.deliver(id);
  }
  private requireBinding(id: string): AutomationBinding {
    const binding = this.store.bindings.get(id);
    if (!binding) throw new AppError(ErrorCode.NotFound, "自动化不存在");
    return binding;
  }
  async dispose(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    this.controller.abort();
    await this.tickFinished;
    await this.active?.promise;
    await this.stream;
    await Promise.allSettled([...this.sending.values()]);
    await this.runtime?.stop();
    this.runtime = undefined;
    this.client = undefined;
  }
}
function eventType(binding: AutomationBinding): string {
  return `automation.${binding.id.replaceAll("-", "")}`;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

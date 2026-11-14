import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AppError,
  ErrorCode,
  CollaborationMemberInput,
  CollaborationRoomInput,
  CollaborationMessageInput,
  CollaborationDecisionInput,
  type CollaborationMember,
  type CollaborationRoom,
  type CollaborationMessage,
  type CollaborationRoomDetail,
  type CollaborationSources,
  type AgentStreamEvent,
  type ToolCallRecord,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { businessDatabase, type BusinessDatabase } from "../db/business-database";
import { newId, nowIso, errorMessage, toJsonSafe } from "../util";
import { sqliteDocuments } from "./storage/async-documents";
import type { AsyncDocumentRepository, TaskPersistence } from "./storage/async-ports";
import type { ProviderService } from "./providers";
import type { ApprovalService } from "./approvals";
import type { CollaborationExecutor } from "./collaboration-executor";

type Receipt = { id: string; fingerprint: string };
type ActiveRound = { controller: AbortController; done: Promise<void> };
const ACTIVE = new Set<CollaborationRoom["status"]>(["running", "waiting_approval"]);
const AGENTS: CollaborationSources["agents"] = [
  { id: "orchestrator", label: "AgentDesk" },
  { id: "research", label: "研究助手" },
  { id: "reviewer", label: "审查员" },
  { id: "project", label: "项目助手" },
  { id: "code", label: "编码助手" },
  { id: "deploy", label: "部署助手" },
];

function evidence(content: string, calls: ToolCallRecord[]): CollaborationMessage["evidence"] {
  const urls = new Map<string, "tool" | "citation">();
  const collect = (text: string, kind: "tool" | "citation") => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'\])}]+/g)) {
      const raw = match[0].replace(/[.,;，。；]+$/, "");
      try {
        const url = new URL(raw);
        if (url.username || url.password) continue;
        if (!urls.has(url.href) || kind === "tool") urls.set(url.href, kind);
      } catch {
        /* 自然语言中不完整的网址不计入证据。 */
      }
      if (urls.size >= 30) break;
    }
  };
  collect(content, "citation");
  for (const call of calls) if (!call.isError) collect(JSON.stringify(call.result) ?? "", "tool");
  return [...urls].slice(0, 30).map(([url, kind]) => ({ url, kind }));
}

/** 本地群协作复用业务库、Provider 和 Agent 执行器，消息身份始终由服务端构造。 */
export class CollaborationService {
  readonly ready: Promise<void>;
  private readonly business: BusinessDatabase;
  private readonly members: AsyncDocumentRepository<CollaborationMember>;
  private readonly rooms: AsyncDocumentRepository<CollaborationRoom>;
  private readonly messages: AsyncDocumentRepository<CollaborationMessage>;
  private readonly receipts: AsyncDocumentRepository<Receipt>;
  private readonly active = new Map<string, ActiveRound>();
  private disposed = false;

  constructor(
    db: Db,
    private readonly providers: Pick<ProviderService, "list" | "validateSelection">,
    private readonly executor: CollaborationExecutor,
    private readonly approvals: Pick<ApprovalService, "get">,
    options: {
      persistence?: Pick<TaskPersistence, "business" | "documents">;
      turnTimeoutMs?: number;
    } = {},
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
    this.business =
      options.persistence?.business ??
      businessDatabase((db as Db & { $client: Database.Database }).$client);
    const documents = <T extends { id: string }>(name: string) =>
      options.persistence?.documents<T>(name) ?? sqliteDocuments<T>(db, name);
    this.members = documents("collaboration_members");
    this.rooms = documents("collaboration_rooms");
    this.messages = documents("collaboration_messages");
    this.receipts = documents("collaboration_requests");
    this.ready = this.business
      .transaction(async () => {
        for (const room of await this.rooms.list()) {
          // 兼容早期房间数据；新消息只在业务事务内分配递增序号。
          const legacyMessages = (await this.messages.list()).filter(
            (message) => message.roomId === room.id,
          );
          if (legacyMessages.some((message) => !message.seq)) {
            legacyMessages.sort(
              (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
            );
            for (const [index, message] of legacyMessages.entries())
              await this.messages.put({ ...message, seq: index + 1 });
          }
          if (!ACTIVE.has(room.status)) continue;
          await this.rooms.put({
            ...room,
            status: "interrupted",
            activeMemberId: undefined,
            pendingApprovalId: undefined,
            phase: undefined,
            updatedAt: nowIso(),
            error: "服务已重启，本轮已中断。保留历史，请明确发起下一轮，系统不会自动重放。",
          });
          for (const message of await this.roomMessages(room.id)) {
            if (message.status === "streaming")
              await this.messages.put({ ...message, status: "failed" });
          }
        }
      })
      .immediate();
  }
  private readonly turnTimeoutMs: number;

  sources(): CollaborationSources {
    return {
      agents: AGENTS,
      providers: this.providers.list().map((provider) => ({
        id: provider.id,
        name: provider.name,
        api: provider.api,
        models: provider.models,
        defaultModel: provider.defaultModel,
        available: provider.enabled && provider.hasKey,
        unavailableReason: !provider.enabled
          ? "Provider 已停用"
          : !provider.hasKey
            ? "尚未配置 API Key"
            : undefined,
      })),
    };
  }
  private presentMember(member: CollaborationMember): CollaborationMember {
    const provider = this.sources().providers.find(
      (value) => value.id === member.modelSelection.providerId,
    );
    const available =
      !!provider?.available && provider.models.includes(member.modelSelection.model);
    return {
      ...member,
      available,
      unavailableReason: available
        ? undefined
        : (provider?.unavailableReason ??
          (provider ? "所选模型已从配置中移除" : "Provider 已移除")),
    };
  }
  async listMembers(): Promise<CollaborationMember[]> {
    await this.ready;
    return (await this.members.list()).map((member) => this.presentMember(member));
  }
  async createMember(input: unknown): Promise<CollaborationMember> {
    await this.ready;
    const data = CollaborationMemberInput.parse(input);
    const provider = this.providers.validateSelection(data.modelSelection);
    if (!provider.models.includes(data.modelSelection.model))
      throw new AppError(ErrorCode.BadRequest, "请选择 Provider 中已配置的模型");
    return this.members.put({ ...data, id: newId(), createdAt: nowIso(), available: true });
  }
  async listRooms(): Promise<CollaborationRoom[]> {
    await this.ready;
    return (await this.rooms.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async requireRoom(id: string): Promise<CollaborationRoom> {
    const room = await this.rooms.get(id);
    if (!room) throw new AppError(ErrorCode.NotFound, "协作房间不存在");
    return room;
  }
  private async roomMessages(id: string): Promise<CollaborationMessage[]> {
    return (await this.messages.list())
      .filter((message) => message.roomId === id)
      .sort((a, b) => a.seq - b.seq);
  }
  async createRoom(input: unknown): Promise<CollaborationRoom> {
    await this.ready;
    const data = CollaborationRoomInput.parse(input);
    const ids = new Set(data.participants.map((participant) => participant.memberId));
    if (ids.size !== data.participants.length)
      throw new AppError(ErrorCode.BadRequest, "房间成员不能重复");
    if (
      !data.participants.some((participant) => participant.role === "research") ||
      !data.participants.some((participant) => participant.role === "verify")
    )
      throw new AppError(ErrorCode.BadRequest, "请至少安排一位调研成员和一位核对成员");
    return this.business
      .transaction(async () => {
        for (const id of ids) {
          const member = await this.members.get(id);
          if (!member) throw new AppError(ErrorCode.NotFound, "成员不存在");
          if (!this.presentMember(member).available)
            throw new AppError(ErrorCode.ProviderUnavailable, `${member.name} 的模型配置不可用`);
        }
        const now = nowIso();
        return this.rooms.put({
          ...data,
          id: newId(),
          maxRounds: data.maxRounds ?? 3,
          status: "idle",
          round: 0,
          createdAt: now,
          updatedAt: now,
        });
      })
      .immediate();
  }
  async detail(id: string): Promise<CollaborationRoomDetail> {
    await this.ready;
    return this.business.exclusive(async () => {
      const room = await this.requireRoom(id);
      const members: CollaborationMember[] = [];
      for (const participant of room.participants) {
        const member = await this.members.get(participant.memberId);
        if (member) members.push(this.presentMember(member));
      }
      const approval = room.pendingApprovalId
        ? await this.approvals.get(room.pendingApprovalId)
        : undefined;
      return {
        room,
        members,
        messages: await this.roomMessages(id),
        pendingApprovals: approval?.status === "pending" ? [approval] : [],
      };
    });
  }
  private async receipt(roomId: string, requestId: string, value: unknown): Promise<boolean> {
    const id = `${roomId}:${requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const previous = await this.receipts.get(id);
    if (previous && previous.fingerprint !== fingerprint)
      throw new AppError(ErrorCode.Conflict, "requestId 已用于另一项请求");
    if (previous) return true;
    await this.receipts.put({ id, fingerprint });
    return false;
  }
  private async ownerMessage(
    room: CollaborationRoom,
    data: CollaborationMessageInput,
    content: string,
  ) {
    const history = await this.roomMessages(room.id);
    if (history.length >= 500)
      throw new AppError(ErrorCode.Conflict, "房间消息已达上限，请创建新房间");
    if (data.replyToId && !history.some((message) => message.id === data.replyToId))
      throw new AppError(ErrorCode.BadRequest, "引用消息不属于当前房间");
    const mentionIds = [...new Set(data.mentionIds ?? [])];
    if (
      mentionIds.some((id) => !room.participants.some((participant) => participant.memberId === id))
    )
      throw new AppError(ErrorCode.BadRequest, "点名成员不属于当前房间");
    const message: CollaborationMessage = {
      id: newId(),
      roomId: room.id,
      author: { kind: "owner", id: "local-owner", name: "你" },
      seq: (history.at(-1)?.seq ?? 0) + 1,
      content,
      status: "complete",
      round: room.round,
      replyToId: data.replyToId,
      mentionIds,
      toolCalls: [],
      evidence: [],
      createdAt: nowIso(),
    };
    return this.messages.put(message);
  }
  async postMessage(id: string, input: unknown): Promise<CollaborationRoomDetail> {
    await this.ready;
    const data = CollaborationMessageInput.parse(input);
    if (!data.content) throw new AppError(ErrorCode.BadRequest, "消息不能为空");
    await this.business
      .transaction(async () => {
        const room = await this.requireRoom(id);
        if (await this.receipt(id, data.requestId, { kind: "message", ...data })) return;
        await this.ownerMessage(room, data, data.content!);
        await this.rooms.put({ ...room, updatedAt: nowIso() });
      })
      .immediate();
    return this.detail(id);
  }
  async discuss(id: string, input: unknown): Promise<CollaborationRoomDetail> {
    const data = CollaborationMessageInput.parse(input);
    return this.start(id, data, { kind: "discuss", ...data });
  }
  private async start(
    id: string,
    data: CollaborationMessageInput,
    receiptValue: unknown,
    decisionOnly = false,
  ): Promise<CollaborationRoomDetail> {
    await this.ready;
    if (this.disposed) throw new AppError(ErrorCode.Conflict, "服务正在退出");
    const reserved = await this.business
      .transaction(async () => {
        const room = await this.requireRoom(id);
        if (await this.receipt(id, data.requestId, receiptValue)) return null;
        if (this.active.has(id) || ACTIVE.has(room.status))
          throw new AppError(ErrorCode.Conflict, "房间已有讨论在执行，请等待或停止");
        if (decisionOnly && room.status !== "awaiting_decision")
          throw new AppError(ErrorCode.Conflict, "当前没有等待用户决定的结论");
        const retry =
          room.round > 0 && ["failed", "cancelled", "interrupted"].includes(room.status);
        if (!retry && room.round >= room.maxRounds)
          throw new AppError(ErrorCode.Conflict, "已达到本房间的讨论轮数上限，请创建新房间");
        for (const participant of room.participants) {
          const member = await this.members.get(participant.memberId);
          if (!member || !this.presentMember(member).available)
            throw new AppError(
              ErrorCode.ProviderUnavailable,
              `${member?.name ?? "成员"} 的模型配置不可用`,
            );
        }
        const next: CollaborationRoom = {
          ...room,
          round: retry ? room.round : room.round + 1,
          status: "running",
          error: undefined,
          activeMemberId: undefined,
          phase: undefined,
          pendingApprovalId: undefined,
          updatedAt: nowIso(),
        };
        const content = data.content ?? room.topic;
        await this.ownerMessage(next, data, content);
        await this.rooms.put(next);
        return { room: next, ownerMessage: content };
      })
      .immediate();
    if (reserved) {
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => this.execute(reserved.room, reserved.ownerMessage, controller))
        .finally(() => this.active.delete(id));
      this.active.set(id, { controller, done });
    }
    return this.detail(id);
  }
  async decide(id: string, input: unknown): Promise<CollaborationRoomDetail> {
    await this.ready;
    const data = CollaborationDecisionInput.parse(input);
    if (data.action === "continue")
      return this.start(
        id,
        {
          requestId: data.requestId,
          content: data.content ?? "继续讨论，请进一步核查分歧与未核实事项。",
        },
        { kind: "decision", ...data },
        true,
      );
    await this.business
      .transaction(async () => {
        const room = await this.requireRoom(id);
        if (await this.receipt(id, data.requestId, { kind: "decision", ...data })) return;
        if (room.status !== "awaiting_decision")
          throw new AppError(ErrorCode.Conflict, "当前没有等待用户决定的结论");
        await this.ownerMessage(
          room,
          { requestId: data.requestId },
          data.content ?? "同意当前结论。",
        );
        await this.rooms.put({ ...room, status: "accepted", updatedAt: nowIso() });
      })
      .immediate();
    return this.detail(id);
  }
  async stop(id: string): Promise<CollaborationRoomDetail> {
    await this.ready;
    this.active.get(id)?.controller.abort();
    await this.business
      .transaction(async () => {
        const room = await this.requireRoom(id);
        if (!ACTIVE.has(room.status)) return;
        await this.rooms.put({
          ...room,
          status: "cancelled",
          activeMemberId: undefined,
          phase: undefined,
          pendingApprovalId: undefined,
          updatedAt: nowIso(),
        });
        for (const message of await this.roomMessages(id))
          if (message.status === "streaming")
            await this.messages.put({ ...message, status: "cancelled" });
      })
      .immediate();
    return this.detail(id);
  }
  private async updateRunning(id: string, round: number, patch: Partial<CollaborationRoom>) {
    return this.business
      .transaction(async () => {
        const current = await this.requireRoom(id);
        if (current.round !== round || !ACTIVE.has(current.status)) return false;
        await this.rooms.put({ ...current, ...patch, updatedAt: nowIso() });
        return true;
      })
      .immediate();
  }
  private async execute(
    room: CollaborationRoom,
    ownerMessage: string,
    controller: AbortController,
  ) {
    let currentMessage: CollaborationMessage | undefined;
    let writes = Promise.resolve();
    try {
      const schedule = [
        ...room.participants.filter((participant) => participant.role === "research"),
        ...room.participants.filter((participant) => participant.role === "verify"),
        ...room.participants.filter((participant) => participant.role === "summarize"),
      ];
      if (!schedule.some((participant) => participant.role === "summarize")) {
        const verifier = room.participants.find((participant) => participant.role === "verify")!;
        schedule.push({ ...verifier, role: "summarize" });
      }
      for (const participant of schedule) {
        controller.signal.throwIfAborted();
        const stored = await this.members.get(participant.memberId);
        if (!stored || !this.presentMember(stored).available)
          throw new AppError(
            ErrorCode.ProviderUnavailable,
            `${stored?.name ?? "成员"} 的模型配置不可用`,
          );
        const member = this.presentMember(stored);
        if (
          !(await this.updateRunning(room.id, room.round, {
            activeMemberId: member.id,
            phase: participant.role,
            status: "running",
            pendingApprovalId: undefined,
          }))
        )
          return;
        const reserved = await this.business
          .transaction(async () => {
            const live = await this.requireRoom(room.id);
            if (controller.signal.aborted || live.round !== room.round || !ACTIVE.has(live.status))
              return null;
            const history = await this.roomMessages(room.id);
            const message: CollaborationMessage = {
              id: newId(),
              roomId: room.id,
              seq: (history.at(-1)?.seq ?? 0) + 1,
              author: {
                kind: "agent",
                id: member.id,
                name: member.name,
                agent: member.agent,
                modelSelection: member.modelSelection,
              },
              role: participant.role,
              round: room.round,
              content: "",
              status: "streaming",
              mentionIds: [],
              replyToId: history.at(-1)?.id,
              evidence: [],
              toolCalls: [],
              createdAt: nowIso(),
            };
            await this.messages.put(message);
            return { history, message };
          })
          .immediate();
        if (!reserved) return;
        const { history, message } = reserved;
        currentMessage = message;
        let lastWrite = 0,
          buffer = "";
        writes = Promise.resolve();
        const emit = (event: AgentStreamEvent) => {
          if (event.type !== "text_delta" || controller.signal.aborted) return writes;
          buffer = (buffer + event.delta).slice(0, 64_000);
          if (Date.now() - lastWrite < 250) return writes;
          lastWrite = Date.now();
          const content = buffer.slice(0, 64_000);
          writes = writes.then(() =>
            this.business
              .transaction(async () => {
                const live = await this.requireRoom(room.id);
                if (
                  !controller.signal.aborted &&
                  live.round === room.round &&
                  ACTIVE.has(live.status)
                )
                  await this.messages.put({ ...message, content });
              })
              .immediate(),
          );
          return writes;
        };
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.turnTimeoutMs),
        ]);
        const result = await this.executor.run({
          room,
          member,
          role: participant.role,
          ownerMessage: `${room.topic}\n\n本机用户本轮要求：${ownerMessage}`,
          history,
          signal,
          emit,
          waiting: async (approvalId) => {
            if (!controller.signal.aborted)
              await this.updateRunning(room.id, room.round, {
                status: approvalId ? "waiting_approval" : "running",
                pendingApprovalId: approvalId,
              });
          },
        });
        await writes;
        signal.throwIfAborted();
        const content = result.text.slice(0, 64_000);
        const calls = toJsonSafe(result.toolCalls);
        await this.business
          .transaction(async () => {
            const live = await this.requireRoom(room.id);
            if (!controller.signal.aborted && live.round === room.round && ACTIVE.has(live.status))
              await this.messages.put({
                ...message,
                content,
                status: "complete",
                toolCalls: calls,
                evidence: evidence(content, calls),
              });
          })
          .immediate();
        currentMessage = undefined;
      }
      if (!controller.signal.aborted)
        await this.updateRunning(room.id, room.round, {
          status: "awaiting_decision",
          activeMemberId: undefined,
          phase: undefined,
          pendingApprovalId: undefined,
        });
    } catch (error) {
      // 等待同一执行器已排队的写入收尾，再落失败状态，防止晚到增量覆盖终态。
      await writes.catch(() => undefined);
      const cancelled = controller.signal.aborted;
      await this.business
        .transaction(async () => {
          const live = await this.requireRoom(room.id);
          if (live.round !== room.round || !ACTIVE.has(live.status)) return;
          if (currentMessage) {
            const partial = await this.messages.get(currentMessage.id);
            await this.messages.put({
              ...(partial ?? currentMessage),
              status: cancelled ? "cancelled" : "failed",
            });
          }
          await this.rooms.put({
            ...live,
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? undefined : errorMessage(error),
            activeMemberId: undefined,
            pendingApprovalId: undefined,
            phase: undefined,
            updatedAt: nowIso(),
          });
        })
        .immediate();
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.active.values()];
    active.forEach((entry) => entry.controller.abort());
    await Promise.allSettled(active.map((entry) => entry.done));
  }
}

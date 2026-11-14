import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AppError,
  ErrorCode,
  TeamRoomInput,
  TeamMessageInput,
  TeamTaskInput,
  TeamCredentialInput,
  TeamProgressInput,
  TeamSubmitInput,
  TeamReviewInput,
  type TeamRoom,
  type TeamMember,
  type TeamMessage,
  type TeamTask,
  type TeamDetail,
  type TeamSession,
  type TeamClaim,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { businessDatabase, type BusinessDatabase } from "../db/business-database";
import { sqliteDocuments } from "./storage/async-documents";
import type { AsyncDocumentRepository, TaskPersistence } from "./storage/async-ports";

type StoredTask = TeamTask & { leaseHash?: string };
type RoomRecord = {
  id: string;
  room: TeamRoom;
  members: TeamMember[];
  messages: TeamMessage[];
  tasks: StoredTask[];
  receipts: Record<string, { fingerprint: string; messageId: string }>;
};
type Credential = {
  id: string;
  roomId: string;
  memberId?: string;
  kind: "invite" | "pair" | "human" | "agent";
  expiresAt: number;
};
export type TeamActor = {
  roomId: string;
  memberId: string;
  kind: "human" | "agent";
  credentialId?: string;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
function fail(message: string, code: ErrorCode = ErrorCode.Conflict): never {
  throw new AppError(code, message);
}
const publicTask = ({ leaseHash: _leaseHash, ...task }: StoredTask): TeamTask => task;

/** 不包含模型服务、文件读取或命令执行能力；团队凭证与个人模型凭据完全分离。 */
export class TeamService {
  private readonly business: BusinessDatabase;
  private readonly records: AsyncDocumentRepository<RoomRecord>;
  private readonly credentials: AsyncDocumentRepository<Credential>;
  constructor(db: Db, persistence?: Pick<TaskPersistence, "business" | "documents">) {
    this.business =
      persistence?.business ??
      businessDatabase((db as Db & { $client: Database.Database }).$client);
    this.records =
      persistence?.documents<RoomRecord>("team_rooms") ?? sqliteDocuments(db, "team_rooms");
    this.credentials =
      persistence?.documents<Credential>("team_credentials") ??
      sqliteDocuments(db, "team_credentials");
  }
  private async credential(kind: Credential["kind"], roomId: string, memberId?: string) {
    for (const old of await this.credentials.list())
      if (old.expiresAt <= Date.now()) await this.credentials.delete(old.id);
    const code = randomBytes(32).toString("base64url");
    const ttl = kind === "invite" ? 86400_000 : kind === "pair" ? 600_000 : 30 * 86400_000;
    await this.credentials.put({
      id: digest(code),
      kind,
      roomId,
      memberId,
      expiresAt: Date.now() + ttl,
    });
    return { code, expiresAt: new Date(Date.now() + ttl).toISOString() };
  }
  async authenticate(token: string): Promise<TeamActor> {
    const credential = await this.credentials.get(digest(token));
    if (
      !credential ||
      credential.expiresAt <= Date.now() ||
      !credential.memberId ||
      !["human", "agent"].includes(credential.kind)
    )
      fail("团队连接已失效，请重新加入或配对", ErrorCode.Unauthorized);
    const record = await this.records.get(credential.roomId);
    if (!record?.members.some((member) => member.id === credential.memberId && !member.revoked))
      fail("成员授权已撤销", ErrorCode.Unauthorized);
    return {
      roomId: credential.roomId,
      memberId: credential.memberId,
      kind: credential.kind as TeamActor["kind"],
      credentialId: credential.id,
    };
  }
  private async access(
    actor: TeamActor,
    owner = false,
  ): Promise<{ record: RoomRecord; me: TeamMember }> {
    if (actor.credentialId) {
      const credential = await this.credentials.get(actor.credentialId);
      if (!credential || credential.expiresAt <= Date.now())
        fail("团队凭证已撤销或过期", ErrorCode.Unauthorized);
    }
    const record = await this.records.get(actor.roomId);
    const me = record?.members.find((member) => member.id === actor.memberId && !member.revoked);
    if (!record || !me) fail("无权访问此项目", ErrorCode.Forbidden);
    if (owner && (me.role !== "owner" || actor.kind !== "human"))
      fail("只有项目负责人本人可以操作", ErrorCode.Forbidden);
    for (const task of record.tasks) {
      if (task.status === "running" && Date.parse(task.leaseExpiresAt ?? "") <= Date.now()) {
        task.status = "blocked";
        task.progress = "连接租约已过期，需负责人明确重试";
        task.leaseHash = undefined;
        task.leaseExpiresAt = undefined;
        task.updatedAt = now();
      }
    }
    return { record, me };
  }
  private async audit(record: RoomRecord, content: string) {
    this.append(record, "system", record.room.ownerId, content);
    await this.records.put(record);
  }
  private append(
    record: RoomRecord,
    kind: TeamMessage["authorKind"],
    authorId: string,
    content: string,
    extra: { replyToId?: string; mentionIds?: string[] } = {},
  ) {
    const message: TeamMessage = {
      id: randomUUID(),
      roomId: record.id,
      seq: (record.messages.at(-1)?.seq ?? 0) + 1,
      authorId,
      authorKind: kind,
      content,
      mentionIds: extra.mentionIds ?? [],
      replyToId: extra.replyToId,
      createdAt: now(),
    };
    record.messages.push(message);
    return message;
  }
  async create(raw: unknown): Promise<TeamSession> {
    const input = TeamRoomInput.parse(raw);
    return this.business
      .transaction(async () => {
        const roomId = randomUUID(),
          memberId = randomUUID();
        const { ownerName, ...data } = input;
        const room: TeamRoom = { ...data, id: roomId, ownerId: memberId, createdAt: now() };
        const member: TeamMember = {
          id: memberId,
          roomId,
          name: ownerName,
          role: "owner",
          revoked: false,
        };
        await this.records.put({
          id: roomId,
          room,
          members: [member],
          messages: [],
          tasks: [],
          receipts: {},
        });
        const { code: token } = await this.credential("human", roomId, memberId);
        return { token, member, room };
      })
      .immediate();
  }
  async invite(actor: TeamActor) {
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor, true);
        return this.credential("invite", record.id);
      })
      .immediate();
  }
  async revokeInvites(actor: TeamActor) {
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor, true);
        for (const credential of await this.credentials.list())
          if (credential.roomId === record.id && credential.kind === "invite")
            await this.credentials.delete(credential.id);
        return { ok: true };
      })
      .immediate();
  }
  async join(raw: unknown): Promise<TeamSession> {
    const input = TeamCredentialInput.parse(raw);
    return this.business
      .transaction(async () => {
        const invite = await this.credentials.get(digest(input.code));
        if (!invite || invite.kind !== "invite" || invite.expiresAt <= Date.now())
          fail("邀请已过期或已使用", ErrorCode.Unauthorized);
        const record = await this.records.get(invite.roomId);
        if (!record || record.members.filter((member) => !member.revoked).length >= 30)
          fail("项目不存在或成员已满");
        const member: TeamMember = {
          id: randomUUID(),
          roomId: record.id,
          name: input.name,
          role: "member",
          revoked: false,
        };
        record.members.push(member);
        await this.credentials.delete(invite.id);
        await this.audit(record, `${member.name} 加入了项目。`);
        const { code: token } = await this.credential("human", record.id, member.id);
        return { token, room: record.room, member };
      })
      .immediate();
  }
  async pairCode(actor: TeamActor) {
    return this.business
      .transaction(async () => {
        await this.access(actor);
        if (actor.kind !== "human") fail("请由成员本人配对 Agent", ErrorCode.Forbidden);
        for (const old of await this.credentials.list())
          if (old.kind === "pair" && old.memberId === actor.memberId)
            await this.credentials.delete(old.id);
        return this.credential("pair", actor.roomId, actor.memberId);
      })
      .immediate();
  }
  async pair(raw: unknown): Promise<TeamSession> {
    const input = TeamCredentialInput.parse(raw);
    return this.business
      .transaction(async () => {
        const ticket = await this.credentials.get(digest(input.code));
        if (!ticket || ticket.kind !== "pair" || ticket.expiresAt <= Date.now() || !ticket.memberId)
          fail("配对码已过期或已使用", ErrorCode.Unauthorized);
        const { record, me } = await this.access({
          ...ticket,
          memberId: ticket.memberId,
          kind: "human",
        });
        for (const old of await this.credentials.list())
          if (old.kind === "agent" && old.memberId === me.id) await this.credentials.delete(old.id);
        this.blockAssigned(record, me.id, "Agent 已重新配对，请明确重试未完成任务");
        me.executor = input.name;
        me.connectedAt = now();
        await this.credentials.delete(ticket.id);
        await this.audit(record, `${me.name} 已连接 ${input.name}。`);
        const { code: token } = await this.credential("agent", record.id, me.id);
        return { token, member: me, room: record.room };
      })
      .immediate();
  }
  private blockAssigned(record: RoomRecord, memberId: string, reason: string) {
    for (const task of record.tasks)
      if (task.assigneeId === memberId && task.status === "running") {
        task.status = "blocked";
        task.leaseHash = undefined;
        task.leaseExpiresAt = undefined;
        task.progress = reason;
        task.updatedAt = now();
      }
  }
  async revoke(actor: TeamActor, memberId: string, connectionOnly = false) {
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor, memberId !== actor.memberId || !connectionOnly);
        if (actor.kind !== "human") fail("请由成员本人撤销", ErrorCode.Forbidden);
        const member = record.members.find((item) => item.id === memberId);
        if (!member) fail("成员不存在", ErrorCode.NotFound);
        if (!connectionOnly && member.role === "owner") fail("不能移除项目负责人");
        for (const credential of await this.credentials.list()) {
          if (credential.memberId === memberId && (!connectionOnly || credential.kind !== "human"))
            await this.credentials.delete(credential.id);
        }
        if (!connectionOnly) member.revoked = true;
        member.connectedAt = undefined;
        this.blockAssigned(record, memberId, "成员或 Agent 授权已撤销");
        await this.audit(
          record,
          `${member.name} 的${connectionOnly ? "Agent 连接" : "项目权限"}已撤销。`,
        );
        return { ok: true };
      })
      .immediate();
  }
  async detail(actor: TeamActor): Promise<TeamDetail> {
    return this.business
      .transaction(async () => {
        const { record, me } = await this.access(actor);
        await this.records.put(record);
        return {
          room: record.room,
          me,
          members: record.members,
          messages: record.messages,
          tasks: record.tasks.map(publicTask),
        };
      })
      .immediate();
  }
  async message(actor: TeamActor, raw: unknown) {
    const input = TeamMessageInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor);
        const key = `${actor.memberId}:${actor.kind}:${input.requestId}`;
        const fingerprint = digest(JSON.stringify(input));
        const receipt = record.receipts[key];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) fail("请求 ID 已用于另一条消息");
          return record.messages.find((message) => message.id === receipt.messageId)!;
        }
        if (input.replyToId && !record.messages.some((message) => message.id === input.replyToId))
          fail("引用不属于当前项目", ErrorCode.BadRequest);
        if (
          input.mentionIds.some(
            (id) => !record.members.some((member) => member.id === id && !member.revoked),
          )
        )
          fail("点名成员不属于当前项目", ErrorCode.BadRequest);
        // 聊天限额不能阻断撤权、停止任务等必要的系统审计记录。
        if (record.messages.length >= 2000) fail("项目消息达到上限，请备份记录后新建项目");
        const message = this.append(record, actor.kind, actor.memberId, input.content, input);
        record.receipts[key] = { fingerprint, messageId: message.id };
        await this.records.put(record);
        return message;
      })
      .immediate();
  }
  async createTask(actor: TeamActor, raw: unknown): Promise<TeamTask> {
    const input = TeamTaskInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor, true);
        if (!record.members.some((member) => member.id === input.assigneeId && !member.revoked))
          fail("负责人不属于此项目", ErrorCode.BadRequest);
        if (record.tasks.length >= 200) fail("项目任务达到上限");
        const ids = [...new Set(input.dependsOn)];
        const dependencies = ids.map((id) => record.tasks.find((task) => task.id === id));
        if (dependencies.some((task) => !task)) fail("依赖任务不属于此项目", ErrorCode.BadRequest);
        if (input.kind === "integrate" && !ids.length)
          fail("集成任务必须选择待汇总的任务", ErrorCode.BadRequest);
        const id = randomUUID();
        const task: StoredTask = {
          ...input,
          dependsOn: ids,
          id,
          roomId: record.id,
          baseRevision: record.room.baseRevision,
          branch: `agentdesk/${id}-1`,
          status: "queued",
          attempt: 0,
          progress: "等待成员本人确认执行",
          createdAt: now(),
          updatedAt: now(),
        };
        record.tasks.push(task);
        await this.audit(record, `已分配任务：${task.title}。`);
        return publicTask(task);
      })
      .immediate();
  }
  async claim(actor: TeamActor): Promise<TeamClaim | null> {
    return this.business
      .transaction(async () => {
        const { record, me } = await this.access(actor);
        if (actor.kind !== "agent") fail("此接口仅供已配对 Agent 使用", ErrorCode.Forbidden);
        me.connectedAt = now();
        const outstanding = record.tasks.some(
          (task) => task.assigneeId === me.id && task.status === "running",
        );
        const task = outstanding
          ? undefined
          : record.tasks.find(
              (task) =>
                task.assigneeId === me.id &&
                task.status === "queued" &&
                task.dependsOn.every((id) =>
                  record.tasks.some((value) => value.id === id && value.status === "approved"),
                ),
            );
        if (!task) {
          await this.records.put(record);
          return null;
        }
        task.attempt++;
        task.branch = `agentdesk/${task.id}-${task.attempt}`;
        const lease = randomBytes(32).toString("base64url");
        task.leaseHash = digest(lease);
        task.leaseExpiresAt = new Date(Date.now() + 45_000).toISOString();
        task.status = "running";
        task.progress = "已领取，等待本机确认";
        task.updatedAt = now();
        await this.audit(record, `${me.name} 的 Agent 已领取：${task.title}。`);
        return {
          task: publicTask(task),
          lease,
          room: record.room,
          dependencies: record.tasks
            .filter((value) => task.dependsOn.includes(value.id))
            .map(publicTask),
        };
      })
      .immediate();
  }
  private leased(record: RoomRecord, actor: TeamActor, id: string, lease: string): StoredTask {
    const task = record.tasks.find((value) => value.id === id);
    if (
      actor.kind !== "agent" ||
      !task ||
      task.assigneeId !== actor.memberId ||
      task.status !== "running" ||
      task.leaseHash !== digest(lease) ||
      Date.parse(task.leaseExpiresAt ?? "") <= Date.now()
    )
      fail("执行租约已失效，停止本机运行并等待明确重试", ErrorCode.Conflict);
    return task;
  }
  async progress(actor: TeamActor, id: string, raw: unknown) {
    const input = TeamProgressInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record, me } = await this.access(actor);
        const task = this.leased(record, actor, id, input.lease);
        task.progress = input.progress;
        task.updatedAt = now();
        task.leaseExpiresAt = new Date(Date.now() + 45_000).toISOString();
        me.connectedAt = now();
        await this.records.put(record);
        return publicTask(task);
      })
      .immediate();
  }
  async block(actor: TeamActor, id: string, raw: unknown) {
    const input = TeamProgressInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor);
        const task = this.leased(record, actor, id, input.lease);
        task.status = "blocked";
        task.progress = input.progress;
        task.leaseHash = undefined;
        task.leaseExpiresAt = undefined;
        task.updatedAt = now();
        await this.audit(record, `任务阻塞：${task.title}。${input.progress}`);
        return publicTask(task);
      })
      .immediate();
  }
  async submit(actor: TeamActor, id: string, raw: unknown) {
    const input = TeamSubmitInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor);
        const task = this.leased(record, actor, id, input.lease);
        if (input.delivery.revision === task.baseRevision)
          fail("交付必须包含新的提交", ErrorCode.BadRequest);
        task.delivery = input.delivery;
        task.status = "submitted";
        task.progress = "已交付，等待负责人验收";
        task.leaseHash = undefined;
        task.leaseExpiresAt = undefined;
        task.updatedAt = now();
        await this.audit(record, `任务交付：${task.title}。测试结果由连接端上报，尚待负责人验收。`);
        return publicTask(task);
      })
      .immediate();
  }
  async review(actor: TeamActor, id: string, raw: unknown) {
    const input = TeamReviewInput.parse(raw);
    return this.business
      .transaction(async () => {
        const { record } = await this.access(actor, true);
        const task = record.tasks.find((value) => value.id === id);
        if (!task) fail("任务不存在", ErrorCode.NotFound);
        if (task.status === "approved" || task.status === "cancelled")
          fail("已结束的任务不能修改，请创建后续任务");
        if (input.action === "approve") {
          if (
            task.status !== "submitted" ||
            !task.delivery ||
            task.delivery.checks.some((check) => check.exitCode !== 0)
          )
            fail("只有测试通过的交付才能验收");
          if (
            task.dependsOn.some(
              (dependency) =>
                !record.tasks.some(
                  (value) => value.id === dependency && value.status === "approved",
                ),
            )
          )
            fail("依赖任务尚未验收");
          task.status = "approved";
        } else if (input.action === "cancel") task.status = "cancelled";
        else {
          if (!(input.action === "retry" ? ["blocked"] : ["submitted"]).includes(task.status))
            fail("当前任务状态不支持此操作");
          task.status = "queued";
          task.delivery = undefined;
        }
        task.review = input.note;
        task.progress = input.note;
        task.updatedAt = now();
        task.leaseHash = undefined;
        task.leaseExpiresAt = undefined;
        await this.audit(record, `负责人处理了「${task.title}」：${input.note}`);
        return publicTask(task);
      })
      .immediate();
  }
}

import { sql } from "drizzle-orm";
import {
  AppError,
  ConversationGroupInput,
  ConversationPatch,
  ConversationQuery,
  ErrorCode,
  type Conversation,
  type ConversationGroup,
  type Project,
} from "@agentdesk/shared";
import { resolve } from "node:path";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { messages } from "../db/schema";
import { newId, nowIso } from "../util";

/** 会话组织信息与消息分开保存，兼容未包含分组等字段的旧数据。 */
export class ConversationService {
  private readonly conversations: Collection<Conversation>;
  private readonly groups: Collection<ConversationGroup>;
  private readonly projects: Collection<Project>;

  constructor(private readonly db: Db) {
    this.conversations = new Collection(db, "conversations");
    this.groups = new Collection(db, "conversationGroups");
    this.projects = new Collection(db, "projects");
  }

  get(id: string): Conversation | undefined {
    const conversation = this.conversations.get(id);
    return conversation ? normalizeConversation(conversation) : undefined;
  }

  put(conversation: Conversation): Conversation {
    const normalized = normalizeConversation(conversation);
    this.conversations.put({ ...normalized, projectId: conversation.projectId });
    return normalized;
  }

  list(input: ConversationQuery = {}): Conversation[] {
    const query = ConversationQuery.parse(input);
    const search = query.search?.toLocaleLowerCase();
    const bodyMatches = search
      ? new Set(
          this.db
            .selectDistinct({ conversationId: messages.conversationId })
            .from(messages)
            .where(sql`instr(lower(${messages.content}), lower(${search})) > 0`)
            .all()
            .map((row) => row.conversationId),
        )
      : null;
    return this.conversations
      .list()
      .map(normalizeConversation)
      .filter((conversation) => {
        if (
          query.archived !== "all" &&
          Boolean(conversation.archived) !== (query.archived === "archived")
        )
          return false;
        if (query.groupId === "ungrouped" && conversation.groupId !== null) return false;
        if (
          query.groupId &&
          query.groupId !== "ungrouped" &&
          conversation.groupId !== query.groupId
        )
          return false;
        return (
          !search ||
          conversation.title.toLocaleLowerCase().includes(search) ||
          bodyMatches?.has(conversation.id)
        );
      })
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id),
      );
  }

  patch(id: string, input: ConversationPatch): Conversation {
    const patch = ConversationPatch.parse(input);
    const current = this.requireConversation(id);
    if (patch.groupId && !this.groups.get(patch.groupId)) {
      throw new AppError(ErrorCode.NotFound, "分组不存在，请刷新后重试");
    }
    if (patch.projectId && !this.projects.get(patch.projectId)) {
      throw new AppError(ErrorCode.NotFound, "项目不存在，请先在项目中心添加");
    }
    return this.put({ ...current, projectId: this.conversations.get(id)?.projectId, ...patch });
  }

  delete(id: string): void {
    this.conversations.delete(id);
  }

  projectWorkspace(id: string): string | undefined {
    const conversation = this.requireConversation(id);
    if (!conversation.projectId) return undefined;
    const project = this.projects.get(conversation.projectId);
    if (!project) throw new AppError(ErrorCode.NotFound, "会话关联的项目已移除，请重新选择项目");
    return project.path;
  }

  hasProjectBinding(id: string): boolean {
    return this.conversations.get(id)?.projectId !== undefined;
  }

  projectIdForWorkspace(workspace: string): string | null {
    const key = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    return this.projects.list().find((project) => key(project.path) === key(workspace))?.id ?? null;
  }

  listGroups(): ConversationGroup[] {
    return this.groups.list().sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  createGroup(input: { name: string }): ConversationGroup {
    const { name } = ConversationGroupInput.parse(input);
    this.requireUniqueGroupName(name);
    const now = nowIso();
    return this.groups.put({ id: newId(), name, createdAt: now, updatedAt: now });
  }

  renameGroup(id: string, input: { name: string }): ConversationGroup {
    const current = this.groups.get(id);
    if (!current) throw new AppError(ErrorCode.NotFound, "分组不存在");
    const { name } = ConversationGroupInput.parse(input);
    this.requireUniqueGroupName(name, id);
    return this.groups.put({ ...current, name, updatedAt: nowIso() });
  }

  deleteGroup(id: string): void {
    if (!this.groups.get(id)) throw new AppError(ErrorCode.NotFound, "分组不存在");
    this.db.transaction(() => {
      for (const conversation of this.conversations.list()) {
        if (conversation.groupId === id) this.put({ ...conversation, groupId: null });
      }
      this.groups.delete(id);
    });
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.get(id);
    if (!conversation) throw new AppError(ErrorCode.NotFound, "会话不存在");
    return conversation;
  }

  private requireUniqueGroupName(name: string, exceptId?: string): void {
    if (
      this.groups
        .list()
        .some(
          (group) =>
            group.id !== exceptId && group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
    ) {
      throw new AppError(ErrorCode.Conflict, "已存在同名分组");
    }
  }
}

function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    pinned: conversation.pinned ?? false,
    archived: conversation.archived ?? false,
    groupId: conversation.groupId ?? null,
    projectId: conversation.projectId ?? null,
  };
}

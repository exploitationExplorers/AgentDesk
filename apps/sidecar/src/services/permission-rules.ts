import { PermissionRule } from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { newId, nowIso } from "../util";

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** 取命令前两个空白分隔的词作为前缀，例如 "npm run build" → "npm run"。 */
export function prefixFor(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** 用户批准 shell.run 时选择"记住该命令前缀"后持久化的规则；命中后跳过审批直接执行。 */
export class PermissionRuleService {
  private readonly store: Collection<PermissionRule>;

  constructor(db: Db) {
    this.store = new Collection<PermissionRule>(db, "permission-rules");
  }

  list(): PermissionRule[] {
    return this.store.list();
  }

  /** prefix 相同（忽略首尾空白）的规则不会重复新增，直接返回已有的那条。 */
  add(prefix: string): PermissionRule {
    const trimmed = prefix.trim();
    const existing = this.store.list().find((rule) => rule.prefix === trimmed);
    if (existing) return existing;
    return this.store.put({ id: newId(), tool: "shell.run", prefix: trimmed, createdAt: nowIso() });
  }

  remove(id: string): boolean {
    return this.store.delete(id);
  }

  match(tool: string, args: unknown): PermissionRule | undefined {
    if (tool !== "shell.run") return undefined;
    const command = commandOf(args)?.trim();
    if (!command) return undefined;
    return this.store.list().find((rule) => command.startsWith(rule.prefix));
  }
}

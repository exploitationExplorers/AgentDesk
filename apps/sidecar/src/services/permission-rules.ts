import type { PermissionRule } from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { newId, nowIso } from "../util";

function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function commandOf(args: unknown): string | undefined {
  return stringField(args, "command");
}

/** 取命令前两个空白分隔的词作为前缀，例如 "npm run build" → "npm run"。 */
export function prefixFor(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** 每种工具用来匹配/持久化规则的标识字符串；未登记的工具不支持记住规则。 */
function keyOf(tool: string, args: unknown): string | undefined {
  if (tool === "shell.run") return commandOf(args)?.trim();
  if (tool === "fs.write") return stringField(args, "path");
  if (tool === "deploy.run") return stringField(args, "recipeId");
  return undefined;
}

/** 为"记住"生成默认 pattern：shell.run 取命令前两个词；其余工具没有更短的自然前缀，直接用完整 key。 */
export function defaultPatternFor(tool: string, args: unknown): string | undefined {
  const key = keyOf(tool, args);
  if (key === undefined) return undefined;
  return tool === "shell.run" ? prefixFor(key) : key;
}

export function describeRule(rule: PermissionRule): string {
  return rule.pattern ? `${rule.tool}: ${rule.pattern}*` : `${rule.tool}（全部调用）`;
}

/** 用户批准/拒绝时选择"记住"后持久化的规则；命中 deny 直接拒绝，命中 allow 跳过审批。 */
export class PermissionRuleService {
  private readonly store: Collection<PermissionRule>;

  constructor(db: Db) {
    this.store = new Collection<PermissionRule>(db, "permission-rules");
  }

  list(): PermissionRule[] {
    return this.store.list();
  }

  /** tool+pattern+decision 相同的规则不会重复新增，直接返回已有的那条。 */
  add(
    tool: string,
    pattern: string,
    decision: PermissionRule["decision"] = "allow",
  ): PermissionRule {
    const trimmed = pattern.trim();
    const existing = this.store
      .list()
      .find((rule) => rule.tool === tool && rule.pattern === trimmed && rule.decision === decision);
    if (existing) return existing;
    return this.store.put({ id: newId(), tool, pattern: trimmed, decision, createdAt: nowIso() });
  }

  remove(id: string): boolean {
    return this.store.delete(id);
  }

  /** deny 永远优先于 allow：两者都命中同一次调用时，先看有没有 deny 规则。 */
  match(tool: string, args: unknown): PermissionRule | undefined {
    const key = keyOf(tool, args);
    const candidates = this.store.list().filter((rule) => {
      if (rule.tool !== tool) return false;
      if (rule.pattern === "") return true;
      return key !== undefined && key.startsWith(rule.pattern);
    });
    return (
      candidates.find((rule) => rule.decision === "deny") ??
      candidates.find((rule) => rule.decision === "allow")
    );
  }
}

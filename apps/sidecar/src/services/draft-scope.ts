import type { ToolContext } from "@agentdesk/agent-core";
import type { z } from "zod";

type ArtifactRecorder = NonNullable<ToolContext["recordArtifact"]>;

/** 持久化自动化按 Task 隔离；普通聊天继续使用本轮的回调能力隔离。 */
export function draftScope<T>(
  ctx: ToolContext,
  scopes: WeakMap<ArtifactRecorder, Map<string, T>>,
  key: string,
  schema: z.ZodType<T>,
): Pick<Map<string, T>, "get" | "set" | "delete" | "size"> {
  ctx.signal?.throwIfAborted();
  if (!ctx.recordArtifact) throw new Error("当前任务不支持保存成果");
  const state = ctx.durableState;
  if (!state) {
    let scope = scopes.get(ctx.recordArtifact);
    if (!scope) {
      scope = new Map();
      scopes.set(ctx.recordArtifact, scope);
    }
    return scope;
  }
  const read = () => {
    const stored = state.get(key);
    if (stored === undefined || stored === null) return new Map<string, T>();
    if (typeof stored !== "object" || Array.isArray(stored)) throw new Error("文稿草稿记录无效");
    const entries = Object.entries(stored);
    if (entries.length > 4) throw new Error("文稿草稿数量超出限制");
    return new Map(entries.map(([id, value]) => [id, schema.parse(value)]));
  };
  const write = (scope: Map<string, T>) => {
    if (scope.size > 4) throw new Error("文稿草稿数量超出限制");
    const value = Object.fromEntries(scope);
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
      throw new Error("文稿草稿内容超出限制");
    state.set(key, value);
  };
  return {
    get size() {
      return read().size;
    },
    get: (id) => read().get(id),
    set: (id, value) => {
      const scope = read();
      scope.set(id, schema.parse(value));
      write(scope);
      return scope;
    },
    delete: (id) => {
      const scope = read();
      const removed = scope.delete(id);
      if (scope.size === 0) state.delete(key);
      else write(scope);
      return removed;
    },
  };
}

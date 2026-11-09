import { createHash } from "node:crypto";
import type { DBAdapter, DBTransactionAdapter, Where } from "better-auth/types";

export const sessionDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Better Auth 负责令牌与签名；适配器只改变持久化格式，不把数据库摘要当作 bearer。 */
export function hashedSessionAdapter<T extends DBAdapter | DBTransactionAdapter>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      if (property === "transaction") {
        return <R>(callback: (transaction: DBTransactionAdapter) => Promise<R>) =>
          (target as DBAdapter).transaction((transaction) =>
            callback(hashedSessionAdapter(transaction)),
          );
      }
      return async (input: {
        model?: string;
        where?: Where[];
        data?: Record<string, unknown>;
        update?: Record<string, unknown>;
        set?: Record<string, unknown>;
      }) => {
        if (input.model !== "session") return Reflect.apply(method, target, [input]);
        const tokens = new Map<string, string>();
        const hash = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(hash);
          if (typeof value !== "string") throw new Error("Invalid session token query");
          const digest = sessionDigest(value);
          tokens.set(digest, value);
          return digest;
        };
        const data = (value: Record<string, unknown> | undefined) =>
          value && "token" in value ? { ...value, token: hash(value.token) } : value;
        const transformed = {
          ...input,
          ...(input.where
            ? {
                where: input.where.map((condition) =>
                  condition.field === "token"
                    ? { ...condition, value: hash(condition.value) }
                    : condition,
                ),
              }
            : {}),
          ...(input.data ? { data: data(input.data) } : {}),
          ...(input.update ? { update: data(input.update) } : {}),
          ...(input.set ? { set: data(input.set) } : {}),
        };
        const restore = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(restore);
          if (
            value &&
            typeof value === "object" &&
            "token" in value &&
            typeof value.token === "string"
          )
            return { ...value, token: tokens.get(value.token) ?? value.token };
          return value;
        };
        return restore(await Reflect.apply(method, target, [transformed]));
      };
    },
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import type { PostgresUnitOfWork } from "./postgres";

export interface BusinessStatement {
  get(...values: unknown[]): Promise<unknown>;
  all(...values: unknown[]): Promise<unknown[]>;
  run(...values: unknown[]): Promise<{ changes: number }>;
}
export interface BusinessDatabase {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): BusinessStatement;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
  transaction<T>(action: () => Promise<T>): (() => Promise<T>) & { immediate(): Promise<T> };
  afterCommit(action: () => void): void;
}

/** 仅供固定仓储 SQL 使用；参数值始终经驱动绑定。 */
export function bindBusinessSql(sql: string, values: unknown[]) {
  let quote = "",
    result = "",
    position = 0;
  const params: unknown[] = [];
  const named =
    values.length === 1 &&
    values[0] !== null &&
    typeof values[0] === "object" &&
    !Array.isArray(values[0])
      ? (values[0] as Record<string, unknown>)
      : undefined;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = "";
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === "?") {
      if (position >= values.length) throw new Error("Missing SQL parameter");
      params.push(values[position++]);
      result += `$${params.length}`;
    } else if (char === "@" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      let key = "";
      while (/[A-Za-z0-9_]/.test(sql[i + 1] ?? "")) key += sql[++i];
      if (!named || !Object.hasOwn(named, key)) throw new Error("Missing named SQL parameter");
      params.push(named[key]);
      result += `$${params.length}`;
    } else result += char;
  }
  // 显式保留仓储返回字段的 camelCase；表名和普通列名沿用小写。
  result = result.replace(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi, (match, name: string) =>
    /[A-Z]/.test(name) ? `AS "${name}"` : match,
  );
  result = result.replace(/\browid\b/g, "created_seq");
  return { sql: result, values: params };
}

const sqliteAdapters = new WeakMap<Database.Database, BusinessDatabase>();
export function businessDatabase(value: Database.Database | BusinessDatabase): BusinessDatabase {
  if ("dialect" in value) return value;
  const cached = sqliteAdapters.get(value);
  if (cached) return cached;
  const raw = value;
  const context = new AsyncLocalStorage<{
    notifications: Array<() => void>;
    transaction: boolean;
  }>();
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    if (context.getStore()) return action();
    const pending = tail.then(() => context.run({ notifications: [], transaction: false }, action));
    tail = pending.catch(() => undefined);
    return pending;
  };
  const adapter: BusinessDatabase = {
    dialect: "sqlite",
    exclusive,
    prepare: (sql) => ({
      get: (...values) => exclusive(async () => raw.prepare(sql).get(...values)),
      all: (...values) => exclusive(async () => raw.prepare(sql).all(...values)),
      run: (...values) =>
        exclusive(async () => ({ changes: raw.prepare(sql).run(...values).changes })),
    }),
    transaction: (action) => {
      const run = () =>
        exclusive(async () => {
          const scope = context.getStore()!;
          if (scope.transaction) return action();
          if (raw.inTransaction)
            throw new Error("Async business transaction cannot join a synchronous transaction");
          raw.exec("BEGIN IMMEDIATE");
          scope.transaction = true;
          let result;
          try {
            result = await action();
            raw.exec("COMMIT");
          } catch (error) {
            raw.exec("ROLLBACK");
            scope.notifications.length = 0;
            throw error;
          } finally {
            scope.transaction = false;
          }
          for (const notify of scope.notifications.splice(0)) notify();
          return result;
        });
      return Object.assign(run, { immediate: run });
    },
    afterCommit: (action) => {
      const scope = context.getStore();
      if (scope?.transaction) scope.notifications.push(action);
      else action();
    },
  };
  sqliteAdapters.set(raw, adapter);
  return adapter;
}

export function postgresBusinessDatabase(db: PostgresUnitOfWork): BusinessDatabase {
  const notifications = new AsyncLocalStorage<Array<() => void>>();
  const query = (sql: string, values: unknown[]) => {
    const bound = bindBusinessSql(sql, values);
    return db.query(bound.sql, bound.values);
  };
  return {
    dialect: "postgres",
    exclusive: (action) => action(),
    prepare: (sql) => ({
      get: async (...values) => (await query(sql, values)).rows[0],
      all: async (...values) => (await query(sql, values)).rows,
      run: async (...values) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
    }),
    transaction: (action) => {
      const run = async () => {
        if (notifications.getStore()) return action();
        const pending: Array<() => void> = [];
        const result = await db.transaction(async () => {
          await db.lock("task-state-transition");
          return notifications.run(pending, action);
        });
        for (const notify of pending) db.afterCommit(notify);
        return result;
      };
      return Object.assign(run, { immediate: run });
    },
    afterCommit: (action) => {
      const pending = notifications.getStore();
      if (pending) pending.push(action);
      else db.afterCommit(action);
    },
  };
}

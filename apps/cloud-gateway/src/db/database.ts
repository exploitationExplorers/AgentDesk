import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { Pool, type PoolClient, types } from "pg";

export interface GatewayStatement {
  get(...values: unknown[]): Promise<unknown>;
  all(...values: unknown[]): Promise<unknown[]>;
  run(...values: unknown[]): Promise<{ changes: number }>;
}

export interface GatewayDatabase {
  readonly dialect: "sqlite" | "postgres";
  readonly authDatabase: Database.Database | Pool;
  exec(sql: string): Promise<void>;
  prepare(sql: string): GatewayStatement;
  transaction<T>(action: () => Promise<T>): (() => Promise<T>) & { immediate(): Promise<T> };
  exclusive<T>(action: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// 只转换仓储中受控 SQL 的占位符，不修改字符串常量或引号标识符中的问号。
export function postgresParameters(sql: string): string {
  let quote = "",
    index = 0,
    result = "";
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
    } else result += char === "?" ? `$${++index}` : char;
  }
  return result;
}

export function sqliteDatabase(raw: Database.Database): GatewayDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  const context = new AsyncLocalStorage<boolean>();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    if (context.getStore()) return action();
    const result = tail.then(() => context.run(true, action));
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    dialect: "sqlite",
    authDatabase: raw,
    exclusive,
    exec: (sql) =>
      exclusive(async () => {
        raw.exec(sql);
      }),
    prepare: (sql) => ({
      get: (...values) => exclusive(async () => raw.prepare(sql).get(...values)),
      all: (...values) => exclusive(async () => raw.prepare(sql).all(...values)),
      run: (...values) =>
        exclusive(async () => ({ changes: raw.prepare(sql).run(...values).changes })),
    }),
    transaction: (action) => {
      const run = () =>
        exclusive(async () => {
          if (raw.inTransaction) return action();
          // Promise 事务不能交给 better-sqlite3.transaction，否则第一次 await 就会提前提交。
          raw.exec("BEGIN IMMEDIATE");
          try {
            const result = await action();
            raw.exec("COMMIT");
            return result;
          } catch (error) {
            raw.exec("ROLLBACK");
            throw error;
          }
        });
      return Object.assign(run, { immediate: run });
    },
    close: async () => {
      await tail;
      raw.close();
    },
  };
}

export function postgresDatabase(pool: Pool): GatewayDatabase {
  const context = new AsyncLocalStorage<PoolClient>();
  // 应用中的时间戳与序号均在 JS 安全整数范围内，超限必须失败而非静默丢精度。
  types.setTypeParser(20, (value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error("Database integer exceeds safe range");
    return parsed;
  });
  const query = (sql: string, values: unknown[] = []) =>
    (context.getStore() ?? pool).query(postgresParameters(sql), values);
  return {
    dialect: "postgres",
    authDatabase: pool,
    exclusive: (action) => action(),
    exec: async (sql) => {
      await query(sql);
    },
    prepare: (sql) => ({
      get: async (...values) => (await query(sql, values)).rows[0],
      all: async (...values) => (await query(sql, values)).rows,
      run: async (...values) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
    }),
    transaction: (action) => {
      const run = async () => {
        if (context.getStore()) return action();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // 同一 Gateway schema 的授权、限流和幂等修改共用事务锁，迁移初期保持单写语义。
          await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), 17892)");
          const result = await context.run(client, action);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      return Object.assign(run, { immediate: run });
    },
    close: () => pool.end(),
  };
}

const sqliteAdapters = new WeakMap<Database.Database, GatewayDatabase>();
export function gatewayDatabase(value: Database.Database | GatewayDatabase): GatewayDatabase {
  if ("dialect" in value) return value;
  let adapter = sqliteAdapters.get(value);
  if (!adapter) {
    adapter = sqliteDatabase(value);
    sqliteAdapters.set(value, adapter);
  }
  return adapter;
}

export async function createPostgresDatabase(connectionString: string, schema = "gateway") {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid database schema");
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=10000`,
  });
  pool.on("error", () => console.error("[gateway] PostgreSQL idle connection failed"));
  try {
    const existing = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
    // 生产角色只拥有自己的 schema，无需获得整个数据库的 CREATE 权限。
    if (!existing.rowCount) await pool.query(`CREATE SCHEMA "${schema}"`);
    return postgresDatabase(pool);
  } catch {
    await pool.end();
    throw new Error("Cannot initialize PostgreSQL business database");
  }
}

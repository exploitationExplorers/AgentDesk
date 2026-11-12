import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

/** 独立于 HTTP 和 Agent 的异步事务边界，同一事务中的仓储复用同一连接。 */
export class PostgresUnitOfWork {
  private readonly context = new AsyncLocalStorage<PoolClient>();
  private readonly notifications = new AsyncLocalStorage<Array<() => void>>();
  private constructor(readonly pool: Pool) {}
  static async connect(connectionString: string, schema = "runner") {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid Runner database schema");
    types.setTypeParser(20, (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number))
        throw new Error("Runner database integer exceeds safe range");
      return number;
    });
    const pool = new Pool({
      connectionString,
      max: 8,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=10000`,
    });
    pool.on("error", () => console.error("[runner] PostgreSQL idle connection failed"));
    try {
      const found = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
      if (!found.rowCount) await pool.query(`CREATE SCHEMA "${schema}"`);
      return new PostgresUnitOfWork(pool);
    } catch {
      await pool.end();
      throw new Error("Cannot initialize Runner PostgreSQL persistence");
    }
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    return (this.context.getStore() ?? this.pool).query<T>(sql, values);
  }
  async transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return action();
    const client = await this.pool.connect();
    const pending: Array<() => void> = [];
    let result: T;
    try {
      await client.query("BEGIN");
      result = await this.context.run(client, () => this.notifications.run(pending, action));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const notify of pending) notify();
    return result;
  }
  async lock(resource: string) {
    if (!this.context.getStore()) throw new Error("Persistence lock requires a transaction");
    await this.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resource]);
  }
  afterCommit(action: () => void): void {
    const pending = this.notifications.getStore();
    if (pending) pending.push(action);
    else action();
  }
  close() {
    return this.pool.end();
  }
}

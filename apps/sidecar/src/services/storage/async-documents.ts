import type { Db } from "../../db/client";
import { Collection } from "../../db/collection";
import { businessDatabase } from "../../db/business-database";
import type Database from "better-sqlite3";
import type { AsyncDocumentRepository } from "./async-ports";

/** 同步 SQLite 集合经宿主共用的队列访问，避免跨 await 事务混入另一请求。 */
export function sqliteDocuments<T extends { id: string }>(
  db: Db,
  name: string,
): AsyncDocumentRepository<T> {
  const collection = new Collection<T>(db, name);
  const business = businessDatabase((db as Db & { $client: Database.Database }).$client);
  return {
    get: (id) => business.exclusive(async () => collection.get(id)),
    list: () => business.exclusive(async () => collection.list()),
    put: (value) => business.exclusive(async () => collection.put(value)),
    update: (id, change) => business.exclusive(async () => collection.update(id, change)),
    delete: (id) => business.exclusive(async () => collection.delete(id)),
  };
}

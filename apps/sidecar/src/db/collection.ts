import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { documents } from "./schema";

/** 基于 documents 表的类型化集合仓储。 */
export class Collection<T extends { id: string }> {
  constructor(
    private readonly db: Db,
    private readonly name: string,
  ) {}

  list(): T[] {
    return this.db
      .select()
      .from(documents)
      .where(eq(documents.collection, this.name))
      .orderBy(desc(documents.updatedAt))
      .all()
      .map((row) => row.data as T);
  }

  get(id: string): T | undefined {
    const row = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.collection, this.name), eq(documents.id, id)))
      .get();
    return row?.data as T | undefined;
  }

  put(value: T): T {
    const now = new Date().toISOString();
    this.db
      .insert(documents)
      .values({ collection: this.name, id: value.id, data: value, updatedAt: now })
      .onConflictDoUpdate({
        target: [documents.collection, documents.id],
        set: { data: value, updatedAt: now },
      })
      .run();
    return value;
  }

  update(id: string, patch: (current: T) => T): T | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    return this.put(patch(current));
  }

  delete(id: string): boolean {
    const result = this.db
      .delete(documents)
      .where(and(eq(documents.collection, this.name), eq(documents.id, id)))
      .run();
    return result.changes > 0;
  }
}

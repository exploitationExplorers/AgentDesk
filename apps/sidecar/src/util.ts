import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const shortHash = (value: string): string =>
  createHash("sha1").update(value.toLowerCase()).digest("hex").slice(0, 12);

export const nowIso = (): string => new Date().toISOString();

/** 本地时区的 YYYY-MM-DD */
export function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function localTime(date = new Date()): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 去掉循环引用和不可序列化的值，保证可以写入 JSON 列 */
export function toJsonSafe<T>(value: T): T {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    }) ?? "null",
  ) as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

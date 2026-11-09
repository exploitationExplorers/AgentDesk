import { createHash } from "node:crypto";
import { z } from "zod";

/** 摘要针对通过 schema 解析后的 JSON；对象键排序，数组顺序保持原语义。 */
export function payloadDigest(value: unknown): string {
  const canonical = (item: z.infer<ReturnType<typeof z.json>>): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key]!)}`)
      .join(",")}}`;
  };
  return createHash("sha256")
    .update(canonical(z.json().parse(value)))
    .digest("hex");
}

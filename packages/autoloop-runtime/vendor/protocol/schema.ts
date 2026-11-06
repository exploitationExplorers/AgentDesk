// JSON Schema, as much of it as protocol/schema.json uses, so checking the protocol needs nothing installed.
import { readFileSync } from "node:fs";
import { dateTime } from "./validate.ts";

export const schemas = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));

function hasType(type: string, item: unknown) {
  if (type === "object") return item !== null && typeof item === "object" && !Array.isArray(item);
  if (type === "array") return Array.isArray(item);
  if (type === "integer") return Number.isSafeInteger(item);
  if (type === "null") return item === null;
  return typeof item === type;
}

const outside = (value: number, min?: number, max?: number) =>
  (min !== undefined && value < min) || (max !== undefined && value > max);

function visit(schema: any, item: any, path: string): string[] {
  const passes = (option: any) => visit(option, item, path).length === 0;
  if (schema.$ref) return visit(schemas.$defs[schema.$ref.split("/").at(-1)], item, path);
  if (schema.anyOf && !schema.anyOf.some(passes)) return [path];
  if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) return [path];
  if (schema.const !== undefined && item !== schema.const) return [path];
  if (schema.enum && !schema.enum.includes(item)) return [path];
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => hasType(type, item))) return [path];
  if (typeof item === "string") {
    if (outside([...item].length, schema.minLength, schema.maxLength)) return [path];
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(item)) return [path];
  }
  if (schema.format === "date-time" && !dateTime(item)) return [path];
  if (typeof item === "number") {
    if (!Number.isFinite(item) || outside(item, schema.minimum, schema.maximum)) return [path];
  }
  if (Array.isArray(item)) {
    if (outside(item.length, schema.minItems, schema.maxItems)) return [path];
    return item.flatMap((child, index) => (schema.items ? visit(schema.items, child, `${path}[${index}]`) : []));
  }
  if (item === null || typeof item !== "object") return [];
  const required: string[] = schema.required ?? [];
  const errors = required.filter((key) => !Object.hasOwn(item, key)).map((key) => `${path}.${key}`);
  for (const [key, child] of Object.entries(item)) {
    const known = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
    const childPath = `${path}.${key}`;
    if (known) errors.push(...visit(known, child, childPath));
    else if (schema.additionalProperties === false) errors.push(childPath);
    else if (typeof schema.additionalProperties === "object") {
      errors.push(...visit(schema.additionalProperties, child, childPath));
    }
  }
  return errors;
}

export function checkSchema(name: string, value: unknown): string[] {
  if (!Object.hasOwn(schemas.$defs, name)) throw new Error(`没有这个协议类型：${name}`);
  return visit(schemas.$defs[name], value, name);
}

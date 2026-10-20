export type Scope = Record<string, unknown>;

export function lookup(scope: Scope, path: string): unknown {
  let current: unknown = scope;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const SINGLE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * 变量插值：整串恰好是一个 {{path}} 时保留原始类型（数组、对象），
 * 否则按字符串拼接。不执行任何表达式。
 */
export function render(template: unknown, scope: Scope): unknown {
  if (typeof template !== "string") return template;
  const single = SINGLE.exec(template);
  if (single?.[1]) return lookup(scope, single[1]);
  return template.replace(ANY, (_, path: string) => {
    const value = lookup(scope, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function renderString(template: unknown, scope: Scope): string {
  const value = render(template, scope);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderConfig(
  config: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, render(v, scope)]));
}

export type ConditionOperator = "eq" | "neq" | "contains" | "gt" | "lt" | "empty" | "notEmpty";

export function evaluateCondition(
  left: unknown,
  operator: ConditionOperator,
  right: unknown,
): boolean {
  const l = typeof left === "string" ? left : JSON.stringify(left ?? "");
  const r = typeof right === "string" ? right : JSON.stringify(right ?? "");
  switch (operator) {
    case "eq":
      return l === r;
    case "neq":
      return l !== r;
    case "contains":
      return l.includes(r);
    case "gt":
      return Number(left) > Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "empty":
      return left === undefined || left === null || l === "" || l === "[]" || l === "{}";
    case "notEmpty":
      return !(left === undefined || left === null || l === "" || l === "[]" || l === "{}");
  }
}

/** ApprovalStep.payload 来自后端 `{tool, args}`（见 agent-core/src/agent.ts），运行时按需收窄。 */
export function parseApprovalPayload(payload: unknown): { tool: string; args: unknown } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.tool !== "string") return null;
  return { tool: record.tool, args: record.args };
}

export function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export interface ApprovalOption {
  id: "yes" | "yes_remember" | "no" | "no_remember";
  label: string;
}

/** 命令前两个词，和后端 permission-rules.ts 的 prefixFor 保持同样的前缀规则。 */
function commandPrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** 描述"记住"选项的文案；和后端 permission-rules.ts 的 keyOf/defaultPatternFor 保持同样的字段取法。 */
function rememberDescription(tool: string, args: unknown): string | undefined {
  if (tool === "shell.run") {
    const command = stringField(args, "command");
    const prefix = command ? commandPrefix(command) : "";
    return prefix ? `"${prefix}" 开头的命令` : undefined;
  }
  if (tool === "fs.write") {
    const path = stringField(args, "path");
    return path ? `文件 ${path}` : undefined;
  }
  if (tool === "deploy.run") {
    const recipeId = stringField(args, "recipeId");
    return recipeId ? `部署配方 ${recipeId}` : undefined;
  }
  return undefined;
}

/** 批准/拒绝之外，已知工具在能算出记住目标时各多一个"批准并记住"/"拒绝并记住"选项。 */
export function approvalOptionsFor(payload: unknown): ApprovalOption[] {
  const options: ApprovalOption[] = [{ id: "yes", label: "批准" }];
  const parsed = parseApprovalPayload(payload);
  const describe = parsed ? rememberDescription(parsed.tool, parsed.args) : undefined;
  if (describe) options.push({ id: "yes_remember", label: `批准并记住${describe}` });
  options.push({ id: "no", label: "拒绝" });
  if (describe) options.push({ id: "no_remember", label: `拒绝并记住${describe}` });
  return options;
}

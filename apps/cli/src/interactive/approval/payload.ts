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
  id: "yes" | "yes_remember" | "no";
  label: string;
}

/** 命令前两个词，和后端 permission-rules.ts 的 prefixFor 保持同样的前缀规则。 */
function commandPrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** 批准/拒绝之外，仅 shell.run 在能算出前缀时多一个"批准并记住"选项。 */
export function approvalOptionsFor(payload: unknown): ApprovalOption[] {
  const options: ApprovalOption[] = [{ id: "yes", label: "批准" }];
  const parsed = parseApprovalPayload(payload);
  if (parsed?.tool === "shell.run") {
    const command = stringField(parsed.args, "command");
    const prefix = command ? commandPrefix(command) : "";
    if (prefix) options.push({ id: "yes_remember", label: `批准并记住"${prefix}"开头的命令` });
  }
  options.push({ id: "no", label: "拒绝" });
  return options;
}

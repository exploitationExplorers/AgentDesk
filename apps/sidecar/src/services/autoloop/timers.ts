import { Type, defineTool, type DurableSuspension } from "@agentdesk/agent-core";
import { AppError, ErrorCode } from "@agentdesk/shared";

export function suspensionTimer(
  suspension?: DurableSuspension,
): { at: string; about: string } | undefined {
  const payload = suspension?.request.payload as
    { kind?: string; at?: string; about?: string } | undefined;
  return payload?.kind === "timer" && payload.at && payload.about
    ? { at: payload.at, about: payload.about }
    : undefined;
}

/** 等待时间和等待回答使用同一安全挂起点，时间到后由 Hub 派发续办。 */
export const waitUntilTool = defineTool({
  name: "tasks.wait_until",
  risk: "safe",
  interactionOnly: true,
  isConcurrencySafe: false,
  description: "暂停当前事项，到指定时间继续处理。等待期间不占用模型和执行槽位。",
  parameters: Type.Object({
    at: Type.String({ description: "含时区的 ISO 8601 时间" }),
    about: Type.String({ minLength: 1, maxLength: 1000 }),
  }),
  execute: async ({ at, about }, ctx) => {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at)))
      throw new AppError(ErrorCode.BadRequest, "等待时间必须是含时区的有效时间");
    if (Date.parse(at) > Date.now() + 366 * 86400000)
      throw new AppError(ErrorCode.BadRequest, "等待时间不能超过一年");
    if (!ctx.requestAnswer) throw new Error("缺少持久化等待支持");
    await ctx.requestAnswer({
      title: "等待指定时间",
      detail: about,
      risk: "safe",
      payload: { kind: "timer", at: new Date(at).toISOString(), about },
    });
    return `等待已结束：${about}`;
  },
});

import { z } from "zod";

export const EntityCardData = z.object({
  variant: z.literal("entity"),
  title: z.string(),
  subtitle: z.string().optional(),
  imageUrl: z.string().optional(),
  rating: z.number().optional(),
  price: z.string().optional(),
  meta: z.string().optional(),
  href: z.string().optional(),
});
export type EntityCardData = z.infer<typeof EntityCardData>;

export const StatusTableCardData = z.object({
  variant: z.literal("status_table"),
  title: z.string().optional(),
  columns: z.array(z.string()).min(1),
  rows: z.array(
    z.object({
      cells: z.array(z.string()),
      status: z.enum(["ok", "error", "neutral"]).optional(),
      statusLabel: z.string().optional(),
    }),
  ),
});
export type StatusTableCardData = z.infer<typeof StatusTableCardData>;

export const AgentDeskCardData = z.discriminatedUnion("variant", [
  EntityCardData,
  StatusTableCardData,
]);
export type AgentDeskCardData = z.infer<typeof AgentDeskCardData>;

export type AgentDeskSegment =
  { kind: "markdown"; text: string } | { kind: "card"; data: AgentDeskCardData };

const FENCE_RE = /```agentdesk-card\s*\n([\s\S]*?)```/gi;

/** 从助手 Markdown 中拆出 agentdesk-card 围栏，供前端白名单渲染。 */
export function parseAgentDeskSegments(text: string): AgentDeskSegment[] {
  const segments: AgentDeskSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      const md = text.slice(last, index).trim();
      if (md) segments.push({ kind: "markdown", text: md });
    }
    try {
      const parsed = AgentDeskCardData.parse(JSON.parse(match[1]!.trim()));
      segments.push({ kind: "card", data: parsed });
    } catch {
      segments.push({ kind: "markdown", text: match[0]! });
    }
    last = index + match[0]!.length;
  }
  const rest = text.slice(last).trim();
  if (rest) segments.push({ kind: "markdown", text: rest });
  if (segments.length === 0 && text) segments.push({ kind: "markdown", text });
  return segments;
}

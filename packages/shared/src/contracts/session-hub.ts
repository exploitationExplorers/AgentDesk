import { z } from "zod";

export const HubTool = z.enum([
  "agentdesk",
  "codex",
  "cursor",
  "claude",
  "gemini",
  "claude-desktop",
  "gemini-desktop",
  "antigravity",
  "grok",
  "web",
]);
export type HubTool = z.infer<typeof HubTool>;
export const hubToolNames: Record<HubTool, string> = {
  agentdesk: "AgentDesk",
  codex: "Codex",
  cursor: "Cursor",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  "claude-desktop": "Claude Desktop",
  "gemini-desktop": "Gemini",
  antigravity: "Antigravity",
  grok: "Grok Bot",
  web: "网页",
};
export const HubPr = z.number().int().min(1).max(999999999);
export const HubWebUrl = z.url({ protocol: /^https?$/ }).max(4096);
export const HubRecord = z.object({
  id: z.string().min(1).max(256),
  tool: HubTool,
  title: z.string().max(300),
  directory: z.string().max(4096),
  branch: z.string().max(500),
  prompt: z.string().max(4000),
  summary: z.string().max(4000),
  updatedAt: z.number().int().nonnegative().max(8640000000000000),
  prs: z.array(HubPr).max(64),
  prLinks: z
    .array(
      z
        .string()
        .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,8}$/),
    )
    .max(64)
    .optional(),
  url: HubWebUrl.optional(),
});
export type HubRecord = z.infer<typeof HubRecord>;
export const HubSnapshot = z.object({
  format: z.literal("agentdesk-session-index-v1"),
  deviceId: z.uuid(),
  deviceName: z.string().trim().min(1).max(128),
  sessions: z.array(HubRecord).max(50000),
});
export type HubSnapshot = z.infer<typeof HubSnapshot>;
export interface HubIndex {
  local: HubSnapshot;
  devices: HubSnapshot[];
  warnings: string[];
  cloud: { available: boolean; enabled: boolean };
}
export const hubKey = (deviceId: string, row: HubRecord) => `${deviceId}:${row.tool}:${row.id}`;

export function parseHubPr(value: string) {
  const q = value.trim();
  const bare = /^(?:pr\s*#?|pull\/|#)?(\d{2,7})$/i.exec(q);
  if (bare && Number(bare[1])) return { number: Number(bare[1]), repo: "" };
  const scoped =
    /^(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|([\w.-]+\/[\w.-]+)#)([1-9]\d{0,8})\/?$/i.exec(
      q,
    );
  return scoped ? { number: Number(scoped[3]), repo: scoped[1] || scoped[2]! } : null;
}
export interface HubResolvedPr {
  number: number;
  title: string;
  branch: string;
  url: string;
  files: string[];
}
export interface HubSearchResult {
  hasMore: boolean;
  hits: { key: string; reason: string; snippet: string }[];
  elapsedMs: number;
  resolved: HubResolvedPr | null;
}

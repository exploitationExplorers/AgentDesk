import { z } from "zod";

export const BrowserSessionState = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  headless: z.boolean(),
  open: z.boolean(),
  lastShotPath: z.string().nullable(),
  /** 供前端拼接的相对 API 路径，如 /api/browser/shots/... */
  lastShotUrl: z.string().nullable(),
  updatedAt: z.string(),
});
export type BrowserSessionState = z.infer<typeof BrowserSessionState>;

export const BrowserActKind = z.enum([
  "goto",
  "click",
  "fill",
  "press",
  "wait",
  "evaluate",
  "screenshot",
]);
export type BrowserActKind = z.infer<typeof BrowserActKind>;

export const BrowserActionInput = z.object({
  kind: BrowserActKind,
  target: z.string().optional(),
  value: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
});
export type BrowserActionInput = z.infer<typeof BrowserActionInput>;

export type BrowserSessionEvent =
  | { type: "session"; session: BrowserSessionState }
  | { type: "frame"; sessionId: string; url: string; title: string; shotUrl: string | null }
  | { type: "closed"; sessionId: string }
  | { type: "ping" };

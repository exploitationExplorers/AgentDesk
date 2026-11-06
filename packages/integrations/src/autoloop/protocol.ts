import { z } from "zod";

export const AUTOLOOP_COMMIT = "22312e16419fc9f542a58044cfbb76f4aec80623";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string();
export const hubEventSchema = z
  .object({
    id: text.min(1).max(200),
    type: text.regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    subject: text
      .max(100)
      .regex(/^[A-Za-z0-9#._:/@-]*$/)
      .optional(),
    summary: text.max(200).optional(),
    detail: text.max(4000).optional(),
  })
  .strict();
export type HubEvent = z.infer<typeof hubEventSchema>;
export const hubJobSchema = z.object({
  run: id,
  token: text.min(1),
  attempt: id,
  rule: z.object({ name: text, cwd: text, prompt: text.optional() }),
  agent: z.object({ id: text, use: text }),
  session: text.nullable(),
  context: z.object({
    events: z.array(
      z.object({
        id: text,
        type: text,
        subject: text.nullable(),
        summary: text.nullable(),
        detail: text.nullable(),
      }),
    ),
    answers: z.array(
      z.object({
        card: id,
        choice: z.number().int().nullable(),
        text: text.nullable(),
        options: z.array(text),
      }),
    ),
    waiting: z.array(z.object({ key: text, at: text, about: text })),
    timers: z.array(z.object({ key: text, at: text, about: text })),
  }),
});
export type HubJob = z.infer<typeof hubJobSchema>;
export const hubWorkSchema = z.object({ job: hubJobSchema.nullable(), cancel: z.array(id) });
export const hubEventAckSchema = z.object({
  event: id,
  duplicate: z.boolean(),
  routed: z.array(text),
});
export const hubReceiptSchema = z.object({
  rejected: z.array(z.unknown()),
  duplicate: z.boolean().optional(),
});
export const hubFactSchema = z.object({
  seq: id,
  type: text,
  changes: z.array(
    z.object({
      table: text,
      key: z.union([text, z.number()]),
      row: z.record(text, z.unknown()).nullable(),
    }),
  ),
});
export type HubFact = z.infer<typeof hubFactSchema>;
export const hubCardSchema = z.object({
  id,
  version: id,
  kind: z.enum(["ask", "notice"]),
  state: z.enum(["open", "decided", "done", "closed"]),
  title: text,
  text,
  options: z.array(text),
  choice: z.number().int().nonnegative().nullable(),
  answer: text.nullable(),
  result: text.nullable(),
});
export type HubCard = z.infer<typeof hubCardSchema>;
export const hubCardStateSchema = z.object({
  cards: z.array(hubCardSchema),
  recentCards: z.array(hubCardSchema),
});
export interface HubResult {
  outcome: "done" | "nothing" | "failed" | "cancelled";
  session?: string;
  summary?: string;
  error?: string;
  usage?: Record<string, number>;
  ask?: Array<{ key: string; title: string; text: string; options: string[]; about?: string }>;
  resolve?: Array<{ card: number; reason: string }>;
  later?: Array<{ key: string; at: string; about: string } | { key: string; cancel: true }>;
}

import { z } from "zod";

export const InterviewImportItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    name: z.string().trim().min(1).max(200),
    text: z.string().trim().min(5).max(120_000),
  }),
  z.object({
    kind: z.literal("url"),
    name: z.string().max(200).optional(),
    url: z.string().url().max(2048),
  }),
  z.object({
    kind: z.literal("file"),
    name: z.string().min(1).max(200),
    base64: z.string().min(1).max(11_200_000),
  }),
]);
export type InterviewImportItem = z.infer<typeof InterviewImportItem>;
export const InterviewBatchInput = z.object({ items: z.array(InterviewImportItem).min(1).max(30) });
export type InterviewBatchInput = z.infer<typeof InterviewBatchInput>;

export const InterviewSource = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["text", "url", "file"]),
  origin: z.string(),
  status: z.enum(["queued", "processing", "ready", "partial", "error"]),
  questionCount: z.number().int(),
  processedParts: z.number().int(),
  totalParts: z.number().int(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InterviewSource = z.infer<typeof InterviewSource>;
export const InterviewQuestion = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  origin: z.string(),
  question: z.string(),
  answer: z.string(),
  answerOrigin: z.enum(["source", "ai", "pending"]),
  sourceExcerpt: z.string(),
  category: z.string(),
  favorite: z.boolean(),
  mastery: z.enum(["new", "learning", "mastered"]),
  reviews: z.number().int(),
  dueDate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestion>;
export const InterviewReviewInput = z.object({
  requestId: z.string().min(8).max(100),
  rating: z.enum(["again", "good", "easy"]),
  timeZone: z.string().min(1).max(100),
});
export type InterviewReviewInput = z.infer<typeof InterviewReviewInput>;
export const InterviewSettingsInput = z.object({
  dailyGoal: z.number().int().min(1).max(100).optional(),
  timeZone: z.string().min(1).max(100).optional(),
  feishuAppId: z.string().trim().max(200).optional(),
  feishuAppSecret: z.string().trim().max(500).optional(),
});
export type InterviewSettingsInput = z.infer<typeof InterviewSettingsInput>;
export interface InterviewSettings {
  dailyGoal: number;
  timeZone: string;
  feishuAppId: string;
  hasFeishuSecret: boolean;
}
export interface InterviewStats {
  date: string;
  total: number;
  mastered: number;
  due: number;
  favorites: number;
  sourceAnswers: number;
  aiAnswers: number;
  pendingAnswers: number;
  todayReviewed: number;
  dailyGoal: number;
  checkedIn: boolean;
  streak: number;
  days: Array<{ date: string; count: number; checkedIn: boolean }>;
  categories: Array<{ name: string; total: number; mastered: number }>;
}
export interface InterviewQuestionPage {
  items: InterviewQuestion[];
  total: number;
  page: number;
  pages: number;
}

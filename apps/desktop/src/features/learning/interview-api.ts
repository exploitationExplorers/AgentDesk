import type {
  InterviewImportItem,
  InterviewQuestion,
  InterviewQuestionPage,
  InterviewReviewInput,
  InterviewSettings,
  InterviewSettingsInput,
  InterviewSource,
  InterviewStats,
} from "@agentdesk/shared";
import { http } from "../../lib/http";

const base = "/learning/interview";
export const interviewApi = {
  sources: () => http.get<InterviewSource[]>(`${base}/sources`),
  import: (items: InterviewImportItem[]) =>
    http.post<InterviewSource[]>(`${base}/imports`, { items }),
  retry: (id: string) => http.post<InterviewSource>(`${base}/sources/${id}/retry`),
  remove: (id: string) => http.delete(`${base}/sources/${id}`),
  questions: (query: Record<string, string | undefined>) =>
    http.get<InterviewQuestionPage>(`${base}/questions`, query),
  favorite: (id: string, favorite: boolean) =>
    http.patch<InterviewQuestion>(`${base}/questions/${id}`, { favorite }),
  review: (id: string, input: InterviewReviewInput) =>
    http.post<InterviewQuestion>(`${base}/questions/${id}/reviews`, input),
  stats: () => http.get<InterviewStats>(`${base}/stats`),
  checkin: () => http.post<InterviewStats>(`${base}/checkin`),
  settings: () => http.get<InterviewSettings>(`${base}/settings`),
  saveSettings: (input: InterviewSettingsInput) =>
    http.put<InterviewSettings>(`${base}/settings`, input),
};

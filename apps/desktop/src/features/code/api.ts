import type { Approval, Project, Run, RunEventRecord, Task } from "@agentdesk/shared";
import { http } from "../../lib/http";

export type CodeSource = "workbench" | "cli";
export const codeApi = (source: CodeSource) => {
  const prefix = source === "cli" ? "/cli-monitor" : "";
  return {
    tasks: () => http.get<Task[]>(`${prefix}/tasks`),
    projects: () => http.get<Project[]>(`${prefix}/projects`),
    addProject: (path: string) => http.post<Project>(`${prefix}/projects`, { path }),
    runs: (id: string) => http.get<Run[]>(`${prefix}/tasks/${encodeURIComponent(id)}/runs`),
    events: (id: string, after: number) =>
      http.get<RunEventRecord[]>(`${prefix}/tasks/${encodeURIComponent(id)}/events`, {
        after: String(after),
        limit: "500",
      }),
    approvals: () => http.get<Approval[]>(`${prefix}/approvals`, { status: "pending" }),
    approve: (id: string, approved: boolean) =>
      http.post(`${prefix}/approvals/${encodeURIComponent(id)}`, { approved }),
    answer: (id: string, text: string) =>
      http.post(`${prefix}/approvals/${encodeURIComponent(id)}/answer`, { text }),
    create: (goal: string, title: string, workspace: string) =>
      http.post<Task>(`${prefix}/tasks`, {
        goal,
        title: title.slice(0, 80),
        agent: "code",
        workspace,
      }),
    cancel: (id: string) => http.post(`${prefix}/tasks/${encodeURIComponent(id)}/cancel`),
    review: (id: string) =>
      http.post(`${prefix}/tasks/${encodeURIComponent(id)}/review`, { approved: true }),
    followup: (id: string, message: string, trigger: "followup" | "resume" | "continue") =>
      http.post<Run>(`${prefix}/tasks/${encodeURIComponent(id)}/runs`, {
        message,
        trigger,
        idempotencyKey: crypto.randomUUID(),
      }),
  };
};

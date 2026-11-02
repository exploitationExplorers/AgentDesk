import type { ProjectInsight, ProjectInsightInput, Task } from "@agentdesk/shared";
import { http } from "../../lib/http";

export const projectInsightsApi = {
  list: (projectId: string) => http.get<ProjectInsight[]>("/project-insights", { projectId }),
  start: (input: ProjectInsightInput) => http.post<ProjectInsight>("/project-insights", input),
  createTasks: (id: string, ids: string[]) =>
    http.post<Task[]>(`/project-insights/${encodeURIComponent(id)}/tasks`, { ids }),
};

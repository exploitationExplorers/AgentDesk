import type { Artifact, ArtifactContent, ArtifactVersionInput } from "@agentdesk/shared";
import { http } from "../../lib/http";
import type { CodeSource } from "./api";

export const artifactsApi = (source: CodeSource = "workbench") => {
  const prefix = source === "cli" ? "/cli-monitor" : "";
  const path = (taskId: string, artifactId?: string) =>
    `${prefix}/tasks/${encodeURIComponent(taskId)}/artifacts${artifactId ? `/${encodeURIComponent(artifactId)}` : ""}`;
  return {
    list: (taskId: string) => http.get<Artifact[]>(path(taskId)),
    content: (taskId: string, artifactId: string) =>
      http.get<ArtifactContent>(`${path(taskId, artifactId)}/content`),
    revise: (taskId: string, artifactId: string, input: ArtifactVersionInput) =>
      http.post<Artifact>(`${path(taskId, artifactId)}/versions`, input),
    downloadPath: (taskId: string, artifactId: string) => `${path(taskId, artifactId)}/download`,
  };
};

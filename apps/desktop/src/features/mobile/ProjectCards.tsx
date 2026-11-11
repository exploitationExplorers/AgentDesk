import { ChevronRight, Cloud, GitBranch, Laptop, Layers } from "lucide-react";
import type { CloudHost, CloudProject } from "../../lib/cloud-api";

export function ProjectCards({
  projects,
  host,
  fallbackBranch,
  onSelect,
}: {
  projects: CloudProject[];
  host: CloudHost | null;
  fallbackBranch: string;
  onSelect: (project: CloudProject) => void;
}) {
  return (
    <div className="m-project-cards">
      {projects.map((project) => {
        const branch = project.branch || fallbackBranch;
        const shortId =
          project.id.length > 22
            ? `${project.id.slice(0, 12)}…${project.id.slice(-7)}`
            : project.id;
        return (
          <button
            key={project.id}
            type="button"
            className="m-project-card"
            onClick={() => onSelect(project)}
          >
            <span className="m-project-card-top">
              <span className="m-project-card-icon">
                <Layers size={18} aria-hidden="true" />
              </span>
              <span className="m-project-card-copy">
                <span className="m-project-card-name">{project.name}</span>
                <span className="m-project-card-sub">
                  {host?.kind === "cloud" ? "默认项目" : "办公室项目"} · {host?.name ?? "未连接"}
                </span>
              </span>
              <ChevronRight className="m-project-card-chevron" size={16} aria-hidden="true" />
            </span>
            <span className="m-project-card-id">ID {shortId}</span>
            <span className="m-project-card-bottom">
              <span className="m-project-card-branch">
                {host?.kind === "cloud" ? (
                  <Cloud size={13} aria-hidden="true" />
                ) : project.branch ? (
                  <GitBranch size={13} aria-hidden="true" />
                ) : (
                  <Laptop size={13} aria-hidden="true" />
                )}
                {host?.kind === "cloud" ? "云端托管" : branch}
              </span>
              <span>{branch}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

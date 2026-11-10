import { useMemo } from "react";
import { ShaderFlood, type ShaderFloodItem } from "@agentdesk/ui";
import type { CloudProject } from "../../lib/cloud-api";

const ICONS: NonNullable<ShaderFloodItem["icon"]>[] = [
  "layers",
  "zap",
  "rocket",
  "globe",
  "aperture",
  "palette",
];

const PALETTES: [string, string, string][] = [
  ["#174f40", "#3d8f6e", "#d5ecdf"],
  ["#2a4a5c", "#5a8aa0", "#d7e7ef"],
  ["#5c4a2a", "#a0845a", "#efe6d7"],
  ["#3d2a5c", "#7a5aa0", "#e7d7ef"],
  ["#1f3d38", "#4f8f7a", "#d3ebe3"],
  ["#3a3f2a", "#8a945a", "#e8ecd7"],
];

export function ProjectFloodCards({
  projects,
  fallbackBranch,
  onSelect,
}: {
  projects: CloudProject[];
  fallbackBranch: string;
  onSelect: (project: CloudProject) => void;
}) {
  const options = useMemo(
    () => ({
      theme: "light" as const,
      background: "transparent",
      items: projects.map((project, index) => ({
        title: project.name,
        description: project.branch || fallbackBranch,
        icon: ICONS[index % ICONS.length],
        colors: PALETTES[index % PALETTES.length],
      })),
    }),
    [fallbackBranch, projects],
  );

  return (
    <ShaderFlood
      className="m-project-flood"
      options={options}
      onItemSelect={(index) => {
        const project = projects[index];
        if (project) onSelect(project);
      }}
    />
  );
}

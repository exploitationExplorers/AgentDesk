import type { AgentName } from "@agentdesk/shared";

const characters: Record<AgentName, string> = {
  orchestrator: "alfred",
  research: "jolly",
  reviewer: "clawd",
  code: "molty",
  project: "cue",
  deploy: "grok",
};

export function CollaborationAvatar({
  agent,
  name,
  className = "",
}: {
  agent?: AgentName;
  name?: string;
  className?: string;
}) {
  if (!agent)
    return (
      <span className={`cc-owner-avatar ${className}`} aria-hidden="true">
        你
      </span>
    );
  const character = characters[agent];
  return (
    <span className={`cc-avatar cc-avatar-${character} ${className}`}>
      <img src={`/reference/avatars/${character}.svg`} alt={name ?? ""} />
    </span>
  );
}

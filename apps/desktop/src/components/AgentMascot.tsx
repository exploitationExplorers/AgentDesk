import { cn } from "@agentdesk/ui";

export function AgentMascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="AgentDesk 像素机器人"
      className={cn("text-emerald-400", className)}
      shapeRendering="crispEdges"
    >
      <path
        fill="currentColor"
        d="M28 4h8v8h16v8h8v24h-8v8h-8v8H32v-8h-8v8H12v-8H8v-8H4V20h8v-8h16z"
      />
      <path fill="#102e29" d="M16 24h8v8h-8zm24 0h8v8h-8zM24 40h16v4H24z" />
      <path fill="#b3f5df" d="M16 16h8v4h-8zM40 16h8v4h-8z" />
    </svg>
  );
}

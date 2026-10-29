import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "@agentdesk/ui";
import { api } from "../lib/api";

export function useAppAvatar(): string {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 30_000 });
  return settings.data?.avatar ?? "";
}

export function AppMark({
  src,
  className,
  alt = "",
}: {
  src?: string;
  className?: string;
  alt?: string;
}) {
  const [broken, setBroken] = useState(false);
  const custom = src && !broken ? src : "";
  return (
    <img
      src={custom || "/agentdesk.svg"}
      alt={alt}
      onError={() => setBroken(true)}
      className={cn("object-cover", className)}
    />
  );
}

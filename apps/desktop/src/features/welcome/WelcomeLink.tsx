import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { scenes } from "./showcase-scenes";

type Destination = (typeof scenes)[number]["links"][number][1];

export function WelcomeLink({
  to,
  install,
  children,
  ...props
}: {
  to: Destination;
  install?: boolean;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  if (import.meta.env.MODE === "welcome") {
    return (
      <a {...props} href="#install">
        {install ? "安装工作台" : children}
      </a>
    );
  }
  return (
    <Link {...props} to={to}>
      {install ? "进入工作台" : children}
    </Link>
  );
}

import type { ReactNode } from "react";
import { AnimatePresence, motion, surfaceTransition, useReducedMotion } from "./motion";

export function AnimatedDisclosure({
  open,
  children,
  id,
}: {
  open: boolean;
  children: ReactNode;
  id?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          id={id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduced ? { duration: 0 } : surfaceTransition}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

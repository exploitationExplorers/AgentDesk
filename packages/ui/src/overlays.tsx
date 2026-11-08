import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./cn";
import { AnimatePresence, drawerVariants, motion, panelVariants } from "./motion";
import { GlassSelection } from "./leibox/glass-tab-menu";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                variants={panelVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className={cn(
                  "lb-glass lb-glass-elevated fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl focus:outline-none",
                  className,
                )}
              >
                <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
                  <div>
                    <DialogPrimitive.Title className="text-[15px] font-semibold">
                      {title}
                    </DialogPrimitive.Title>
                    {description ? (
                      <DialogPrimitive.Description className="mt-1 text-[12.5px] text-muted">
                        {description}
                      </DialogPrimitive.Description>
                    ) : (
                      <DialogPrimitive.Description className="sr-only">
                        {String(title)}
                      </DialogPrimitive.Description>
                    )}
                  </div>
                  <DialogPrimitive.Close
                    className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                    aria-label="关闭"
                  >
                    <X className="h-4 w-4" />
                  </DialogPrimitive.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
                {footer ? (
                  <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>
                ) : null}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  width = 520,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                style={{ width }}
                variants={drawerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="lb-glass lb-glass-elevated fixed right-0 top-0 z-50 flex h-full max-w-[94vw] flex-col border-l focus:outline-none"
              >
                <div className="flex items-center justify-between border-b px-5 py-3.5">
                  <DialogPrimitive.Title className="text-[15px] font-semibold">
                    {title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="sr-only">
                    {String(title)}
                  </DialogPrimitive.Description>
                  <DialogPrimitive.Close
                    className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                    aria-label="关闭"
                  >
                    <X className="h-4 w-4" />
                  </DialogPrimitive.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-leibox="glass-tab-menu"
      className={cn("lb-glass lb-tabs-list", className)}
      {...props}
    >
      <GlassSelection selector="[role=tab][data-state=active]" />
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn("lb-tabs-trigger transition-colors hover:text-fg", className)}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("pt-5 focus:outline-none", className)} {...props} />;
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = "right",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className="lb-glass lb-glass-elevated z-50 rounded-lg px-2 py-1 text-[12px] text-fg animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

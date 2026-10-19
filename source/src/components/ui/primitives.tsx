import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

// -- Badge -------------------------------------------------------------------

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none border",
  {
    variants: {
      tone: {
        neutral: "bg-surface-3 text-ink-dim border-edge",
        accent: "bg-accent-soft text-accent border-accent/30",
        ok: "bg-ok/12 text-ok border-ok/30",
        warn: "bg-warn/12 text-warn border-warn/30",
        bad: "bg-bad/12 text-bad border-bad/30",
        info: "bg-info/12 text-info border-info/30",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// -- Input / Textarea --------------------------------------------------------

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-[10px] border border-edge bg-surface-1 px-3 text-sm text-ink",
        "placeholder:text-ink-mute focus:border-accent focus:outline-none transition-colors",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-[10px] border border-edge bg-surface-1 px-3 py-2 text-sm text-ink",
        "placeholder:text-ink-mute focus:border-accent focus:outline-none resize-y",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 rounded-[10px] border border-edge bg-surface-1 px-2.5 text-sm text-ink",
        "focus:border-accent focus:outline-none cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}

// -- Switch ------------------------------------------------------------------

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full",
        "border border-edge transition-colors data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-4",
        className,
      )}
      {...props}
    >
      {/* Themed rather than hardcoded white: on a light track a white thumb
          with no edge is invisible, which is the whole of the control. */}
      <SwitchPrimitive.Thumb
        style={{
          background: "var(--switch-thumb)",
          borderColor: "var(--switch-thumb-border)",
        }}
        className={cn(
          "pointer-events-none block size-[16px] rounded-full border shadow transition-transform",
          "data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-[2px]",
          "rtl:data-[state=checked]:-translate-x-[20px] rtl:data-[state=unchecked]:-translate-x-[2px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/** Labelled settings row with a switch on the right. */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {description ? (
          <div className="text-[12.5px] text-ink-mute mt-0.5">
            {description}
          </div>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

// -- Separator / Skeleton / Progress ----------------------------------------

export function Separator({
  className,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      className={cn("bg-edge h-px w-full", className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-3", className)}
      data-testid="skeleton"
      {...props}
    />
  );
}

export function Meter({
  value,
  tone = "accent",
}: {
  value: number;
  tone?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-4 overflow-hidden">
      <div
        className={cn("h-full rounded-full transition-all", `bg-${tone}`)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// -- Tooltip -----------------------------------------------------------------

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 rounded-md border border-edge bg-surface-3 px-2 py-1 text-[12px] text-ink shadow-lg"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// -- Dialog ------------------------------------------------------------------

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2",
          "surface-card p-5 shadow-2xl ffn-rise",
          className,
        )}
      >
        <DialogPrimitive.Title className="text-base font-semibold text-ink mb-3">
          {title}
        </DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// -- States ------------------------------------------------------------------

/**
 * There is one set of state components, and it lives in `@/components/state`.
 *
 * These two names stay here because half the app already imports them from
 * this module, and because the versions that used to live here had a hardcoded
 * English "Try again" in them. Prefer the real module for anything new — it
 * has the other nine states.
 */
export { EmptyState, ErrorState } from "@/components/state";

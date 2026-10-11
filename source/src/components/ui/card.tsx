import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("surface-card", className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 px-4 pt-4 pb-2",
        className,
      )}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        {icon ? (
          <div className="text-accent mt-0.5 shrink-0">{icon}</div>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink leading-tight truncate">
            {title}
          </h2>
          {subtitle ? (
            <p className="text-[13px] text-ink-mute mt-0.5">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}

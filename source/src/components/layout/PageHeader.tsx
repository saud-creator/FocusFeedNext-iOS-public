import type { ReactNode } from "react";
import { ConnectionControls } from "@/components/session/ConnectionControls";
import { usePlatform } from "@/lib/platform";

/**
 * Every page's header, and the home of the connection area.
 *
 * The chip and Test Connection live here rather than in each page so they are
 * genuinely always visible: a reader who hits a failure on any screen can see
 * the state and re-test without first finding Diagnostics.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  showConnection = true,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Off for screens that are themselves about the connection. */
  showConnection?: boolean;
}) {
  const { isIphone } = usePlatform();

  return (
    <header className="sticky top-0 z-20 pt-[env(safe-area-inset-top)] backdrop-blur-xl bg-[color-mix(in_srgb,var(--surface-0)_88%,transparent)] border-b border-edge">
      <div className="flex items-center justify-between gap-3 px-3 sm:px-6 py-3.5">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold text-ink leading-tight truncate">
            {title}
          </h1>
          {subtitle ? (
            <div className="text-[12.5px] text-ink-mute mt-0.5 leading-snug break-words">
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showConnection && !isIphone ? <ConnectionControls /> : null}
          {actions}
        </div>
      </div>
    </header>
  );
}

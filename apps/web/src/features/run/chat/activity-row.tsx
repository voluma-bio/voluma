/**
 * One row of a process fold: an icon chip on a timeline rail, a one-line title with a status
 * dot, and an inline expand whose contents are built only when opened. Ported from Meridian
 * Flow's `ActivityRow` (apps/app/src/features/chat), restyled onto voluma's tokens: running is
 * the info blue (DESIGN.md: blue means running), failed the destructive red.
 */
import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

export type ActivityRowStatus = "running" | "done" | "error";

// The chip sits on the title's first line: the line box of `text-ui`.
const LINE_BOX = "box-content min-h-[calc(var(--text-ui)*var(--text-ui--line-height))]";

export function ActivityRow({
  Icon,
  quietIcon = false,
  title,
  status,
  expand,
  children,
  proseClassName = "",
}: {
  Icon: LucideIcon;
  /** Keep the rail but draw no chip: reasoning recedes next to the actions around it. */
  quietIcon?: boolean;
  title?: ReactNode;
  status?: ActivityRowStatus;
  /** Called on open, not on render. */
  expand?: () => ReactNode;
  children?: ReactNode;
  proseClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = `${panelId}-title`;

  // `flex-col` is load-bearing: `flex-1` on the rail must grow down, not sideways.
  const iconColumn = (firstLinePad: string) =>
    quietIcon ? (
      <div className="flex w-[19px] shrink-0 flex-col items-center" aria-hidden>
        <span className="w-px flex-1 bg-border" />
      </div>
    ) : (
      <div className="flex w-[19px] shrink-0 flex-col items-center pt-[3px]">
        <span className={`flex items-center ${LINE_BOX} ${firstLinePad}`}>
          <span className="grid size-[19px] shrink-0 place-items-center rounded-md bg-muted text-fg-subtle">
            <Icon className="size-3" aria-hidden />
          </span>
        </span>
        <span className="mt-0.5 w-px flex-1 bg-border" aria-hidden />
      </div>
    );

  if (!title && children) {
    return (
      <div className="flex items-stretch gap-2">
        {iconColumn("")}
        <div className={`min-w-0 flex-1 pt-[3px] text-ui text-muted-foreground ${proseClassName}`}>
          {children}
        </div>
      </div>
    );
  }

  const dot =
    status === "running" ? (
      <span
        className="mt-[7px] size-1.5 shrink-0 rounded-full bg-info motion-safe:animate-pulse"
        role="img"
        aria-label="Running"
      />
    ) : status === "error" ? (
      <span
        className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive"
        role="img"
        aria-label="Failed"
      />
    ) : null;

  return (
    <div className="flex items-stretch gap-2">
      {iconColumn("py-0.5")}
      <div className="min-w-0 flex-1 pt-[3px]">
        <div
          className={`relative -mx-1 flex items-start gap-2 rounded-md px-1 py-0.5 ${
            expand ? "transition-colors hover:bg-accent" : ""
          }`}
        >
          <span id={titleId} className="min-w-0 truncate text-ui font-medium text-foreground">
            {title}
          </span>
          {dot}
          {expand && (
            <ChevronRight
              className={`mt-1 size-3 shrink-0 text-fg-subtle transition-transform duration-200 ${open ? "rotate-90" : ""}`}
              aria-hidden
            />
          )}
          {expand && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-labelledby={titleId}
              className="absolute inset-0 rounded-md"
            />
          )}
        </div>
        {expand && (
          <div
            id={panelId}
            className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <div className="min-w-0 overflow-hidden">
              <div className="mt-1 pb-1">{open ? expand() : null}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

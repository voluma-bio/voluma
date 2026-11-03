/**
 * Depth inside a row: a quiet line with a chevron that opens what sits under it (the AI's steps,
 * a reply's files).
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cx } from "./cx";

export type DisclosureProps = {
  /** What opens, e.g. "Files (6)". */
  label: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

export function Disclosure({ label, children, className, ...openProps }: DisclosureProps) {
  const [open, setOpen] = useOpen(openProps);
  const bodyId = useId();
  return (
    <div className={cx("border-t border-border", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(!open)}
        className={cx(
          "flex h-8 w-full cursor-pointer items-center gap-2 text-left text-sm transition-colors hover:text-foreground",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          open ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none",
            open ? "rotate-90 text-foreground" : "text-fg-subtle",
          )}
        />
        {label}
      </button>
      {open && (
        <div id={bodyId} className="pb-3 pl-[22px]">
          {children}
        </div>
      )}
    </div>
  );
}

/** Open state, controlled when `open` is given. */
function useOpen({
  open,
  defaultOpen = false,
  onOpenChange,
}: Pick<DisclosureProps, "open" | "defaultOpen" | "onOpenChange">) {
  const [own, setOwn] = useState(defaultOpen);
  const value = open ?? own;
  const set = (next: boolean) => {
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return [value, set] as const;
}

/**
 * Facts about a thing, one click away (Run details, a scan's facts, an agent's or a task's info).
 * Radix underneath: the trigger toggles it, Escape and a click outside close it, and focus moves
 * in and back. `Facts` is the label and value list most popovers hold, `FactSections` several of
 * them under titles, and `InfoButton` the quiet (i) that opens them beside what they describe.
 * Wrap a link in `PopoverClose` to close the popover as it navigates. The content mounts only
 * while open, so a clock inside it ticks only while someone reads it.
 */
import { Info } from "lucide-react";
import { Popover as P } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { IconButton } from "./button";
import { cx } from "./cx";
import { floatingClass, useThemedPortal } from "./portal";

export type PopoverProps = {
  /** The element that opens it, usually a Button. */
  trigger: ReactElement;
  children: ReactNode;
  /** Edge of the trigger it lines up with. */
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name when the content has no heading. */
  label?: string;
  /** Width and padding overrides; 340 px with 16 px padding by default. */
  className?: string;
};

export function Popover({
  trigger,
  children,
  align = "end",
  side = "bottom",
  open,
  onOpenChange,
  label,
  className,
}: PopoverProps) {
  const portal = useThemedPortal(onOpenChange);
  return (
    <P.Root open={open} onOpenChange={portal.onOpenChange}>
      <P.Trigger asChild ref={portal.ref}>
        {trigger}
      </P.Trigger>
      <P.Portal>
        <P.Content
          data-theme={portal.theme}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={cx(
            floatingClass,
            "w-[340px] max-w-[calc(100vw-16px)] p-4 focus-visible:outline-none",
            className,
          )}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

export const PopoverClose = P.Close;

export type FactsProps = {
  /** Label and value pairs, in reading order. */
  items: [label: string, value: ReactNode][];
  className?: string;
};

export function Facts({ items, className }: FactsProps) {
  return (
    <dl
      className={cx("m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm", className)}
    >
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="whitespace-nowrap text-fg-subtle">{label}</dt>
          <dd className="m-0 min-w-0 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type FactSection = {
  /** Omitted for the first section, which the popover's trigger already names. */
  title?: string;
  items: FactsProps["items"];
};

/** Fact lists one after another, each under its title, with a rule between them. */
export function FactSections({ sections }: { sections: FactSection[] }) {
  return (
    <div className="grid gap-3">
      {sections
        .filter((s) => s.items.length > 0)
        .map((s, i) => (
          <section key={s.title ?? i} className={cx(i > 0 && "border-t border-border pt-3")}>
            {s.title && (
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{s.title}</h3>
            )}
            <Facts items={s.items} />
          </section>
        ))}
    </div>
  );
}

export type InfoButtonProps = {
  /** What it tells, as its accessible name and tooltip: "Agent details". */
  label: string;
  children: ReactNode;
  align?: PopoverProps["align"];
  /** Held open, as in a story; left out, the button opens and closes it. */
  open?: boolean;
};

/**
 * The quiet (i) beside a thing: what it took, cost and counted, which the reader asks for
 * rather than scans for. Holds `FactSections` or `Facts`.
 */
export function InfoButton({ label, children, align = "start", open }: InfoButtonProps) {
  return (
    <Popover
      label={label}
      align={align}
      open={open}
      className="w-80 p-3"
      trigger={
        <IconButton size="sm" label={label} className="text-fg-subtle hover:text-foreground">
          <Info />
        </IconButton>
      }
    >
      {children}
    </Popover>
  );
}

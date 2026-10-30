/**
 * Facts about a thing, one click away (Run details, a scan's facts). Radix underneath: the
 * trigger toggles it, Escape and a click outside close it, and focus moves in and back.
 * `Facts` is the label and value list most popovers hold; wrap a link in `PopoverClose` to close
 * the popover as it navigates.
 */
import { Popover as P } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
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
    <dl className={cx("m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-subtle">{label}</dt>
          <dd className="m-0 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

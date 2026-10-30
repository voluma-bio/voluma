/**
 * Facts about a thing, one click away (Run details, a scan's facts). Radix underneath: the
 * trigger toggles it, Escape and a click outside close it, and focus moves in and back.
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
  const [ref, container] = useThemedPortal();
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild ref={ref}>
        {trigger}
      </P.Trigger>
      <P.Portal container={container}>
        <P.Content
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

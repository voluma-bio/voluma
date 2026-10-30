/**
 * Tooltip: a control's name and, when it has one, the key that does the same. Built on Radix, so
 * it opens on hover and on keyboard focus, closes on Escape, and renders in a portal clear of any
 * clipping panel. The child must be one element that takes a ref (a button). The portal sits
 * outside the trigger's `data-theme` subtree, so the tooltip copies the trigger's theme (`useThemedPortal`).
 */
import { Tooltip as Radix } from "radix-ui";
import type { ReactElement } from "react";
import { useThemedPortal } from "./portal";

export type TooltipProps = {
  /** The control's name, e.g. "Full view". */
  label: string;
  /** Its shortcut, e.g. "F". */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
};

export function Tooltip({ label, shortcut, side = "top", children }: TooltipProps) {
  const portal = useThemedPortal();
  return (
    <Radix.Provider delayDuration={400} skipDelayDuration={300}>
      <Radix.Root onOpenChange={portal.onOpenChange}>
        <Radix.Trigger ref={portal.ref} asChild>
          {children}
        </Radix.Trigger>
        <Radix.Portal>
          <Radix.Content
            data-theme={portal.theme}
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex items-center gap-2 rounded-md bg-inverse px-2 py-1 text-xs text-inverse-fg shadow-pop"
          >
            {label}
            {shortcut && <kbd className="font-mono text-xs opacity-70">{shortcut}</kbd>}
          </Radix.Content>
        </Radix.Portal>
      </Radix.Root>
    </Radix.Provider>
  );
}

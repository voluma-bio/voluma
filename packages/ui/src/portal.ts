/**
 * Floating parts (popover, menu) render in a portal so no panel clips them, but the theme is set
 * on a subtree (`data-theme`), not the document. This puts the portal inside the trigger's themed
 * subtree, so a menu opened in the dark review is dark. Popper content is fixed-positioned, so
 * the subtree's overflow doesn't clip it.
 */
import { useCallback, useState } from "react";

/** A ref for the trigger, and the container to pass to the part's `Portal`. */
export function useThemedPortal() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    if (node) setContainer(node.closest<HTMLElement>("[data-theme]"));
  }, []);
  return [ref, container ?? undefined] as const;
}

/** The floating surface both parts share. */
export const floatingClass =
  "z-50 rounded-lg bg-popover text-base text-popover-foreground shadow-pop ring-1 ring-line-strong";

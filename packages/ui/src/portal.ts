/**
 * Floating parts (popover, menu, tooltip) render in a portal on `<body>` so no panel clips them,
 * but the theme is set on a subtree (`data-theme`), not the document. They copy the trigger's
 * theme onto their content: read when the trigger mounts (an open-by-default part) and again
 * on each open (the trigger may have moved to another theme since).
 */
import { useCallback, useRef, useState } from "react";

const themeOf = (node: Element | null) =>
  node?.closest("[data-theme]")?.getAttribute("data-theme") ?? undefined;

/**
 * Pass `ref` to the Radix trigger, `onOpenChange` to its root (it calls yours) and `theme` as the
 * content's `data-theme`.
 */
export function useThemedPortal(onOpenChange?: (open: boolean) => void) {
  const trigger = useRef<HTMLElement | null>(null);
  const [theme, setTheme] = useState<string>();
  const ref = useCallback((node: HTMLElement | null) => {
    trigger.current = node;
    if (node) setTheme(themeOf(node));
  }, []);
  return {
    ref,
    theme,
    onOpenChange: (open: boolean) => {
      if (open) setTheme(themeOf(trigger.current));
      onOpenChange?.(open);
    },
  };
}

/** The floating surface popover and menu share. */
export const floatingClass =
  "z-50 rounded-lg bg-popover text-base text-popover-foreground shadow-pop ring-1 ring-line-strong";

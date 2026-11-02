/**
 * Floating parts (popover, menu, tooltip) render in a portal on `<body>`, outside the subtree
 * that carries the theme (`data-theme`). `ThemeScope` sets that attribute and provides the same
 * theme to the parts below it; they read it with `useTheme` and put it on their portalled
 * content. Outside any scope there is no theme and the content inherits the document's.
 */
import { createContext, type ReactNode, useContext } from "react";

export type Theme = "light" | "dark";

const ThemeContext = createContext<Theme | undefined>(undefined);

export const useTheme = () => useContext(ThemeContext);

export function ThemeScope({
  theme,
  className,
  children,
}: {
  theme: Theme;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ThemeContext.Provider value={theme}>
      <div data-theme={theme} className={className}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** The floating surface popover and menu share. */
export const floatingClass =
  "z-50 rounded-lg bg-popover text-base text-popover-foreground shadow-pop ring-1 ring-line-strong";

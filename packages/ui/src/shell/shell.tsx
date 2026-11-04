/**
 * The app shell: one frame on every screen. A header line across the top, the rail (`Rail`) at
 * the far left, and the main area. A screen lays out its own side panels (`SidePanel`): the shell
 * keeps whether each side is folded, so it carries across pages. The main area (`children`) is
 * rendered once and never remounts when a side folds, so a viewer inside it keeps its state.
 *
 * Visible controls fold panels; scoped Escape leaves Full view.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ThemeScope } from "../portal";

export type ShellSide = "left" | "right";

type ShellState = {
  /** Which sides are folded: a `SidePanel` shows as its strip. */
  folded: Record<ShellSide, boolean>;
  fold(side: ShellSide | "both", folded: boolean): void;
};

export const ShellContext = createContext<ShellState | null>(null);
const HeadingContext = createContext<HTMLElement | null>(null);

export function AppShell({
  brand,
  rail,
  theme,
  children,
}: {
  /** The non-interactive brand mark in the header, above the rail. */
  brand: ReactNode;
  /** The app's rail (`Rail`), at the far left under the header line. */
  rail: ReactNode;
  /** The whole frame's theme, chosen by the app; image wells use their own viewer tokens. */
  theme: "light" | "dark";
  children: ReactNode;
}) {
  const [folded, setFolded] = useState<Record<ShellSide, boolean>>({ left: false, right: false });
  const fullOpener = useRef<HTMLElement | null>(null);
  const fold = useCallback((side: ShellSide | "both", value: boolean) => {
    if (side === "both") {
      if (value) fullOpener.current = document.activeElement as HTMLElement;
      else requestAnimationFrame(() => fullOpener.current?.focus());
    }
    setFolded((f) =>
      side === "both"
        ? f.left === value && f.right === value
          ? f
          : { left: value, right: value }
        : f[side] === value
          ? f
          : { ...f, [side]: value },
    );
  }, []);
  const full = folded.left && folded.right;
  const [heading, setHeading] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [role='dialog'], [role='menu']")
      )
        return;
      if (!target.closest("[data-shell-workspace]")) return;
      if (event.key === "Escape") {
        // Esc belongs to an open menu, popover or dialog first.
        if (!full) return;
        if (target.closest("[role=menu], [role=dialog], [data-radix-popper-content-wrapper]"))
          return;
        fold("both", false);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fold, full]);

  const state = useMemo<ShellState>(() => ({ folded, fold }), [folded, fold]);

  return (
    <ShellContext.Provider value={state}>
      <HeadingContext.Provider value={heading}>
        <ThemeScope theme={theme} className="flex h-dvh flex-col bg-background text-foreground">
          <header className="flex h-[var(--header-h)] shrink-0 items-center border-b border-border bg-card">
            <div className="grid w-11 shrink-0 place-items-center">{brand}</div>
            <div ref={setHeading} className="flex min-w-0 flex-1 items-center gap-3 px-3.5" />
          </header>
          <div className="flex min-h-0 flex-1">
            {rail}
            <main
              data-shell-workspace
              className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-card"
            >
              {children}
            </main>
          </div>
        </ThemeScope>
      </HeadingContext.Provider>
    </ShellContext.Provider>
  );
}

/** Whether Full view is on (both sides folded), and a way for the screen to turn it on or off. */
export function useFullView(): [boolean, (full: boolean) => void] {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useFullView must be used inside AppShell");
  return [shell.folded.left && shell.folded.right, (full) => shell.fold("both", full)];
}

/**
 * Folds `side` while `active`, and puts it back when `active` ends or the screen unmounts, unless
 * it was folded already or the person unfolded it in the meantime.
 */
export function useFoldWhile(side: ShellSide, active: boolean): void {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useFoldWhile must be used inside AppShell");
  const { fold } = shell;
  const folded = shell.folded[side];
  // Whether this hook folded the side, so only it unfolds it; and the fold as last rendered.
  const mine = useRef(false);
  const was = useRef(folded);
  const latest = useRef(folded);
  latest.current = folded;
  useEffect(() => {
    if (!active) return;
    if (!latest.current) {
      mine.current = true;
      fold(side, true);
    }
    return () => {
      if (mine.current) fold(side, false);
      mine.current = false;
    };
  }, [active, side, fold]);
  useEffect(() => {
    const before = was.current;
    was.current = folded;
    if (mine.current && before && !folded) {
      mine.current = false;
    }
  }, [folded]);
}

/** What the header line says about this screen: where you are, and its one-line facts. */
export function ShellHeading({ children }: { children: ReactNode }) {
  const slot = useContext(HeadingContext);
  return slot ? createPortal(children, slot) : null;
}

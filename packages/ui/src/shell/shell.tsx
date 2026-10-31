/**
 * The app shell: one frame on every screen. A header line across the top; an icon strip at each
 * edge; up to two docked panels per side between the strip and the main area. Panels push the
 * main area aside, never float over it, so the 3D views are never covered.
 *
 * A screen declares its panels by rendering `<ShellPanel>` anywhere inside its own tree: the panel
 * puts its button on the strip and, while open, portals its content into the dock. Rendering from
 * the screen's own tree keeps its providers (query client, selection) around the panel content.
 * The main area (`children`) is rendered once and never remounts when panels open, close or
 * resize, so a viewer inside it keeps its state.
 *
 * Keys: `\` and `]` fold the left and right side, F toggles Full view (both sides folded), Esc
 * leaves it, and each panel may claim one key. Shift-click on a strip button stacks a second panel
 * on that side. Widths, the stacked split and which panels are open persist in localStorage.
 */
import { X } from "lucide-react";
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
import { cx } from "../cx";

export type ShellSide = "left" | "right";

export type ShellPanelProps = {
  /** Unique across the app; also the key its open state is stored under. */
  id: string;
  side: ShellSide;
  /** Strip buttons are grouped (e.g. the study's sections, then the open scan's panels). */
  group?: string;
  label: string;
  icon: ReactNode;
  /** A number on the strip button: how many need you. */
  count?: number;
  /** One key that toggles this panel. */
  shortcut?: string;
  /** Opens the first time this panel appears, if its side has never been arranged. */
  defaultOpen?: boolean;
  /** The narrowest the side may be while this panel is open, in px. */
  minWidth?: number;
  /** Tools in the panel's head, before its close button. */
  tools?: ReactNode;
  children: ReactNode;
};

type Registration = Omit<ShellPanelProps, "children" | "tools" | "icon"> & {
  /** A ref, so a screen that builds a new icon element every render does not re-register; the
   * strip reads the latest on its next render. */
  icon: { current: ReactNode };
  order: number;
  /** A strip button that goes somewhere instead of opening a panel (`ShellLink`). */
  link?: { active: boolean; go(): void };
};

type Layout = {
  open: Record<ShellSide, string[]>;
  width: Record<ShellSide, number>;
  /** The top panel's share of the height when two are stacked. */
  split: Record<ShellSide, number>;
  /** Sides the user has arranged; `defaultOpen` applies only before that. */
  arranged: ShellSide[];
};

const STORAGE_KEY = "voluma.shell";
const WIDTH = {
  left: { min: 280, max: 720, initial: 400 },
  right: { min: 280, max: 600, initial: 340 },
};
const MAIN_MIN = 480;

function loadLayout(): Layout {
  const fallback: Layout = {
    open: { left: [], right: [] },
    width: { left: WIDTH.left.initial, right: WIDTH.right.initial },
    split: { left: 0.5, right: 0.5 },
    arranged: [],
  };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      stored &&
      Array.isArray(stored.arranged) &&
      stored.arranged.every((side: unknown) => side === "left" || side === "right") &&
      (["left", "right"] as const).every(
        (side) =>
          Array.isArray(stored.open?.[side]) &&
          stored.open[side].length <= 2 &&
          stored.open[side].every((id: unknown) => typeof id === "string") &&
          new Set(stored.open[side]).size === stored.open[side].length &&
          Number.isFinite(stored.width?.[side]) &&
          stored.width[side] >= WIDTH[side].min &&
          stored.width[side] <= WIDTH[side].max &&
          Number.isFinite(stored.split?.[side]) &&
          stored.split[side] >= 0.2 &&
          stored.split[side] <= 0.8,
      )
    )
      return stored;
  } catch {
    // Storage may be unavailable, or an older build may have written another shape.
  }
  return fallback;
}

function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Disabled or full storage must not make the shell unusable.
  }
}

type ShellState = {
  register(reg: Registration): void;
  unregister(id: string): void;
  slot(id: string): HTMLElement | null;
  isOpen(id: string): boolean;
  toggle(reg: Registration, stack: boolean): void;
  open(id: string): void;
};

const ShellContext = createContext<ShellState | null>(null);
const HeadingContext = createContext<HTMLElement | null>(null);

let nextOrder = 0;

/** Registering the same panel again is a no-op, so a screen's re-render does not re-render the shell. */
function sameRegistration(a: Registration | undefined, b: Registration) {
  if (!a) return false;
  const { link: linkA, ...restA } = a;
  const { link: linkB, ...restB } = b;
  return (
    Object.keys(restB).every(
      (k) => restA[k as keyof typeof restA] === restB[k as keyof typeof restB],
    ) && linkA?.active === linkB?.active
  );
}

export function AppShell({
  logo,
  account,
  theme,
  children,
}: {
  /** The mark at the left of the header line, linking home. */
  logo: ReactNode;
  /** The right end of the header line. */
  account: ReactNode;
  /** The whole frame's theme: light on study pages, dark in the 3D review. */
  theme: "light" | "dark";
  children: ReactNode;
}) {
  const [regs, setRegs] = useState<Map<string, Registration>>(() => new Map());
  const [layout, setLayout] = useState(loadLayout);
  const [full, setFull] = useState(false);
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  const [heading, setHeading] = useState<HTMLElement | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const hasLeftStrip = [...regs.values()].some((r) => r.side === "left");
  const hasRightStrip = [...regs.values()].some((r) => r.side === "right");
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const strips = [hasLeftStrip && el.firstElementChild, hasRightStrip && el.lastElementChild];
      setAvailable(
        el.clientWidth -
          strips.reduce((sum, child) => sum + (child ? child.getBoundingClientRect().width : 0), 0),
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasLeftStrip, hasRightStrip]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // A drag changes the layout on every pointermove; it is saved once, when the pointer goes up.
  const dragging = useRef(false);
  // Full view only hides the saved layout; it never changes which panels are open.
  useEffect(() => {
    if (!dragging.current) saveLayout(layout);
  }, [layout]);
  const onDragging = useCallback((active: boolean) => {
    dragging.current = active;
    if (!active) saveLayout(layoutRef.current);
  }, []);

  // Panels that are open but whose screen no longer renders them stay in `layout.open`, so they
  // come back when the screen does; only registered ones show.
  const shown = useMemo(
    () => ({
      left: full ? [] : layout.open.left.filter((id) => regs.has(id)),
      right: full ? [] : layout.open.right.filter((id) => regs.has(id)),
    }),
    [layout.open, regs, full],
  );

  const register = useCallback((reg: Registration) => {
    setRegs((prev) =>
      sameRegistration(prev.get(reg.id), reg) ? prev : new Map(prev).set(reg.id, reg),
    );
    if (reg.defaultOpen)
      setLayout((l) =>
        l.arranged.includes(reg.side) || l.open[reg.side].includes(reg.id)
          ? l
          : { ...l, open: { ...l.open, [reg.side]: [...l.open[reg.side], reg.id].slice(-2) } },
      );
  }, []);
  const unregister = useCallback((id: string) => {
    setRegs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (reg: Registration, stack: boolean) => {
      if (reg.link) return reg.link.go();
      setFull(false);
      setLayout((l) => {
        const open = full ? [] : l.open[reg.side];
        const next = open.includes(reg.id)
          ? open.filter((id) => id !== reg.id)
          : stack
            ? [...open, reg.id].slice(-2)
            : [reg.id];
        return {
          ...l,
          open: { ...l.open, [reg.side]: next },
          arranged: [...new Set([...l.arranged, reg.side])],
        };
      });
    },
    [full],
  );

  const lastOpen = useRef<Layout["open"]>({ left: [], right: [] });
  const foldSide = useCallback((side: ShellSide) => {
    // A side that never had a panel open has nothing to fold, and arranging it would stop its
    // `defaultOpen` panels from opening on their own.
    if (!layoutRef.current.open[side].length && !lastOpen.current[side].length) return;
    setFull(false);
    setLayout((l) => {
      if (l.open[side].length) lastOpen.current[side] = l.open[side];
      const next = l.open[side].length ? [] : lastOpen.current[side];
      return {
        ...l,
        open: { ...l.open, [side]: next },
        arranged: [...new Set([...l.arranged, side])],
      };
    });
  }, []);

  const toggleFull = useCallback(() => setFull((value) => !value), []);

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
      if (event.key === "\\") foldSide("left");
      else if (event.key === "]") foldSide("right");
      else if (event.key === "Escape") {
        // Esc belongs to an open menu, popover or dialog first.
        if (!full || event.defaultPrevented) return;
        if (target.closest("[role=menu], [role=dialog], [data-radix-popper-content-wrapper]"))
          return;
        toggleFull();
      } else if (event.key.toLowerCase() === "f") toggleFull();
      else {
        const reg = [...regs.values()].find((r) => r.shortcut === event.key.toLowerCase());
        if (!reg) return;
        toggle(reg, event.shiftKey);
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [foldSide, toggleFull, toggle, regs, full]);

  // A screen opens one of its panels: it joins what is open on its side, as Shift-click stacks
  // it. From Full view it brings the saved layout back with the panel added. Stable, so a
  // screen's callbacks built on it don't change when panels do.
  const regsRef = useRef(regs);
  regsRef.current = regs;
  const open = useCallback((id: string) => {
    const reg = regsRef.current.get(id);
    if (!reg || reg.link) return;
    setFull(false);
    setLayout((l) =>
      l.open[reg.side].includes(id)
        ? l
        : {
            ...l,
            open: { ...l.open, [reg.side]: [...l.open[reg.side], id].slice(-2) },
            arranged: [...new Set([...l.arranged, reg.side])],
          },
    );
  }, []);

  const state = useMemo<ShellState>(
    () => ({
      register,
      unregister,
      slot: (id) => slots[id] ?? null,
      isOpen: (id) => shown.left.includes(id) || shown.right.includes(id),
      toggle,
      open,
    }),
    [register, unregister, slots, shown, toggle, open],
  );

  // One stable ref callback per panel: a new callback each render would detach and reattach the
  // slot, set state, and render again forever.
  const slotRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const setSlot = (id: string) => {
    let fn = slotRefs.current.get(id);
    if (!fn) {
      let current: HTMLElement | null = null;
      fn = (el) => {
        if (!el && current?.contains(document.activeElement)) triggers.current.get(id)?.focus();
        current = el;
        setSlots((s) => (s[id] === el ? s : { ...s, [id]: el }));
      };
      slotRefs.current.set(id, fn);
    }
    return fn;
  };

  const minimum = (side: ShellSide) =>
    shown[side].length
      ? Math.max(WIDTH[side].min, ...shown[side].map((id) => regs.get(id)?.minWidth ?? 0))
      : 0;
  const min = { left: minimum("left"), right: minimum("right") };
  const wanted = {
    left: min.left ? Math.max(min.left, layout.width.left) : 0,
    right: min.right ? Math.max(min.right, layout.width.right) : 0,
  };
  // As in the redesign, each side gives up its spare width before squeezing the main area.
  // If even the panel minima do not fit, keep them usable; do not persist a negative width.
  const spare = wanted.left - min.left + wanted.right - min.right;
  const shrink = Math.min(
    1,
    Math.max(0, wanted.left + wanted.right + MAIN_MIN - available) / (spare || 1),
  );
  const widths = {
    left: wanted.left - (wanted.left - min.left) * shrink,
    right: wanted.right - (wanted.right - min.right) * shrink,
  };
  const resize = (side: ShellSide, width: number) => {
    const room = available - widths[side === "left" ? "right" : "left"] - MAIN_MIN;
    const ceiling = Math.max(min[side], Math.min(WIDTH[side].max, room));
    const clamped = Math.round(Math.max(min[side], Math.min(ceiling, width)));
    setLayout((l) => ({ ...l, width: { ...l.width, [side]: clamped } }));
  };

  const dock = (side: ShellSide) =>
    shown[side].length > 0 && (
      <Dock
        side={side}
        width={widths[side]}
        minWidth={min[side]}
        maxWidth={Math.max(
          min[side],
          Math.min(
            WIDTH[side].max,
            available - widths[side === "left" ? "right" : "left"] - MAIN_MIN,
          ),
        )}
        split={layout.split[side]}
        onResize={(w) => resize(side, w)}
        onSplit={(s) => setLayout((l) => ({ ...l, split: { ...l.split, [side]: s } }))}
        onFold={() => foldSide(side)}
        onDragging={onDragging}
      >
        {shown[side].map((id) => {
          const reg = regs.get(id);
          if (!reg) return null;
          return (
            <section
              key={id}
              aria-label={reg.label}
              className="flex min-h-0 flex-1 flex-col bg-card"
              ref={setSlot(id)}
            />
          );
        })}
      </Dock>
    );

  const strip = (side: ShellSide) => {
    const items = [...regs.values()]
      .filter((r) => r.side === side)
      .sort((a, b) => a.order - b.order);
    const groups = [...new Set(items.map((r) => r.group ?? ""))];
    if (!items.length) return null;
    return (
      <nav
        aria-label={side === "left" ? "Sections" : "Tools"}
        className={cx(
          "flex w-[var(--strip-w)] shrink-0 flex-col items-stretch gap-1 bg-card py-2",
          side === "left" ? "border-r border-border" : "border-l border-border",
        )}
      >
        {groups.map((g, i) => (
          <div
            key={g}
            className={cx("flex flex-col gap-1", i > 0 && "mt-1 border-t border-border pt-2")}
          >
            {items
              .filter((r) => (r.group ?? "") === g)
              .map((r) => {
                const active = r.link ? r.link.active : shown[side].includes(r.id);
                return (
                  <button
                    key={r.id}
                    ref={(el) => {
                      if (el) triggers.current.set(r.id, el);
                      else triggers.current.delete(r.id);
                    }}
                    type="button"
                    aria-pressed={r.link ? undefined : active}
                    aria-current={r.link?.active ? "page" : undefined}
                    title={r.shortcut ? `${r.label} (${r.shortcut.toUpperCase()})` : r.label}
                    onClick={(e) => toggle(r, e.shiftKey)}
                    className={cx(
                      "relative mx-1 flex cursor-pointer flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5 text-[10px] leading-tight tracking-tight",
                      active
                        ? "bg-select-tint text-select-text"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className="[&>svg]:size-4">{r.icon.current}</span>
                    <span className="max-w-full text-center text-balance">{r.label}</span>
                    {r.count != null && r.count > 0 && (
                      <span className="absolute top-0.5 right-1 rounded-full bg-check-solid px-1 font-mono text-[10px] text-check-solid-fg leading-[14px]">
                        {r.count}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        ))}
      </nav>
    );
  };

  return (
    <ShellContext.Provider value={state}>
      <HeadingContext.Provider value={heading}>
        <div data-theme={theme} className="flex h-dvh flex-col bg-background text-foreground">
          <header className="flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-border bg-card pr-3">
            <div className="flex shrink-0 items-center pl-4">{logo}</div>
            <div ref={setHeading} className="flex min-w-0 flex-1 items-center gap-3" />
            {account}
          </header>
          <div ref={frame} className="flex min-h-0 flex-1">
            {strip("left")}
            {dock("left")}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-card">
              {children}
            </main>
            {dock("right")}
            {strip("right")}
          </div>
        </div>
      </HeadingContext.Provider>
    </ShellContext.Provider>
  );
}

function Dock({
  side,
  width,
  minWidth,
  maxWidth,
  split,
  onResize,
  onSplit,
  onFold,
  onDragging,
  children,
}: {
  side: ShellSide;
  width: number;
  minWidth: number;
  maxWidth: number;
  split: number;
  onResize(width: number): void;
  onSplit(split: number): void;
  onFold(): void;
  onDragging(active: boolean): void;
  children: ReactNode[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (event: React.PointerEvent, kind: "width" | "split") => {
    const el = ref.current;
    if (!el) return;
    event.preventDefault();
    onDragging(true);
    const rect = el.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      if (kind === "width")
        onResize(side === "left" ? e.clientX - rect.left : rect.right - e.clientX);
      else onSplit(Math.min(0.8, Math.max(0.2, (e.clientY - rect.top) / rect.height)));
    };
    const up = () => {
      onDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [top, bottom] = children;
  return (
    <div
      ref={ref}
      style={{ width }}
      className={cx(
        "relative flex shrink-0 flex-col bg-border",
        side === "left" ? "border-r border-border" : "border-l border-border",
      )}
    >
      {bottom ? (
        <>
          <div style={{ height: `${split * 100}%` }} className="flex min-h-0 flex-col">
            {top}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> can't take focus or pointer drags */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the two panels"
            aria-valuenow={Math.round(split * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            tabIndex={0}
            onPointerDown={(e) => drag(e, "split")}
            onKeyDown={(e) => {
              if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              if (e.key === "ArrowUp") onSplit(Math.max(0.2, split - 0.05));
              if (e.key === "ArrowDown") onSplit(Math.min(0.8, split + 0.05));
            }}
            className="h-1 shrink-0 cursor-row-resize bg-border outline-none hover:bg-select focus-visible:bg-select"
          />
          <div className="flex min-h-0 flex-1 flex-col">{bottom}</div>
        </>
      ) : (
        top
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> can't take focus or pointer drags */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        title="Drag to resize, double-click to fold"
        onPointerDown={(e) => drag(e, "width")}
        onDoubleClick={onFold}
        onKeyDown={(e) => {
          if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
          e.preventDefault();
          const step = side === "left" ? 16 : -16;
          if (e.key === "ArrowRight") onResize(width + step);
          if (e.key === "ArrowLeft") onResize(width - step);
        }}
        className={cx(
          "absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize outline-none hover:bg-select focus-visible:bg-select",
          side === "left" ? "-right-1" : "-left-1",
        )}
      />
    </div>
  );
}

/** A docked panel: its button on the strip, its content in the dock while open. */
export function ShellPanel({ children, tools, ...props }: ShellPanelProps) {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellPanel must be rendered inside AppShell");
  const order = useRef(nextOrder++).current;
  const { register, unregister } = shell;
  const { id, side, group, label, count, shortcut, defaultOpen, minWidth } = props;
  const icon = useRef(props.icon);
  icon.current = props.icon;
  useEffect(() => {
    register({ id, side, group, label, icon, count, shortcut, defaultOpen, minWidth, order });
  }, [register, id, side, group, label, count, shortcut, defaultOpen, minWidth, order]);
  useEffect(() => () => unregister(id), [unregister, id]);
  const slot = shell.isOpen(id) ? shell.slot(id) : null;
  return slot
    ? createPortal(
        <>
          <header className="flex h-[var(--panel-head-h)] shrink-0 items-center gap-2 border-b border-border px-3">
            <h2 className="min-w-0 truncate font-medium text-base">{label}</h2>
            {count != null && (
              <span className="font-mono text-muted-foreground text-xs">{count}</span>
            )}
            <span className="flex-1" />
            {tools}
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => shell.toggle({ ...props, icon, order }, false)}
              className="grid size-6 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </>,
        slot,
      )
    : null;
}

/** Opens a panel of this screen by id, beside what is open on its side. */
export function useOpenPanel(): (id: string) => void {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useOpenPanel must be used inside AppShell");
  return shell.open;
}

/** What the header line says about this screen: where you are, and its one-line facts. */
export function ShellHeading({ children }: { children: ReactNode }) {
  const slot = useContext(HeadingContext);
  return slot ? createPortal(children, slot) : null;
}

/** A strip button that goes to a page (a study section, Home) rather than opening a panel. */
export function ShellLink({
  id,
  side = "left",
  group,
  label,
  icon: iconNode,
  count,
  shortcut,
  active,
  go,
}: Pick<ShellPanelProps, "id" | "group" | "label" | "icon" | "count" | "shortcut"> & {
  side?: ShellSide;
  active: boolean;
  go(): void;
}) {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellLink must be rendered inside AppShell");
  const order = useRef(nextOrder++).current;
  const { register, unregister } = shell;
  const goRef = useRef(go);
  goRef.current = go;
  const icon = useRef(iconNode);
  icon.current = iconNode;
  useEffect(() => {
    register({
      id,
      side,
      group,
      label,
      icon,
      count,
      shortcut,
      order,
      link: { active, go: () => goRef.current() },
    });
  }, [register, id, side, group, label, count, shortcut, order, active]);
  useEffect(() => () => unregister(id), [unregister, id]);
  return null;
}

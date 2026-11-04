/**
 * A screen's side panel: one per side, between the rail and the main area or at the right edge.
 * Its head holds tabs (the left side: Conversation, Samples) or a title with tools (the right
 * side: Final outputs), and a fold button. The seam beside it resizes it; each side's width is
 * kept across pages and visits, so the study and an input open at the widths last used. Folded (its
 * button) it is a 28 px strip with its name and badge; what
 * is inside stays mounted, so a conversation keeps its scroll and its draft.
 */
import { PanelLeftClose, PanelRightClose } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import { Button } from "../button";
import { cx } from "../cx";
import { ShellContext, type ShellSide } from "./shell";

const WIDTH: Record<ShellSide, { min: number; max: number; initial: number }> = {
  left: { min: 220, max: 520, initial: 300 },
  right: { min: 280, max: 560, initial: 360 },
};
const STORAGE_KEY = "voluma.sides";
const STRIP = 28;

/** Both sides' widths, read once from storage and shared by every panel on every page. */
const widths = (() => {
  let value = { left: WIDTH.left.initial, right: WIDTH.right.initial };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    for (const side of ["left", "right"] as const)
      if (Number.isFinite(stored?.[side])) value = { ...value, [side]: clamp(side, stored[side]) };
  } catch {
    // Storage may be unavailable, or hold something else.
  }
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Saved only when `save`: a drag moves the panel on every pointermove and saves once. */
    set(side: ShellSide, width: number, save: boolean) {
      const next = clamp(side, width);
      if (next !== value[side]) {
        value = { ...value, [side]: next };
        for (const listener of listeners) listener();
      }
      if (save)
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch {
          // Disabled or full storage must not stop a resize.
        }
    },
  };
})();

function clamp(side: ShellSide, width: number) {
  return Math.round(Math.max(WIDTH[side].min, Math.min(WIDTH[side].max, width)));
}

export type SidePanelTab = {
  id: string;
  label: string;
  icon: ReactNode;
  /** A count that asks for attention, e.g. 1 while main waits on you. */
  badge?: number;
  /** What the badge counts, for its tooltip and screen readers. */
  badgeLabel?: string;
  /** Stays mounted while another tab shows. */
  content: ReactNode;
};

type Titled = {
  title: string;
  /** A short fact beside the title, e.g. "1 of 2 in". */
  meta?: ReactNode;
  icon: ReactNode;
  badge?: number;
  badgeLabel?: string;
  /** Controls in the head, before the fold button. */
  tools?: ReactNode;
  children: ReactNode;
  tabs?: never;
};

type Tabbed = {
  tabs: SidePanelTab[];
  /** The tab shown. */
  tab: string;
  onTabChange(id: string): void;
  title?: never;
  meta?: never;
};

export type SidePanelProps = { side: ShellSide } & (Titled | Tabbed);

export function SidePanel(props: SidePanelProps) {
  const { side } = props;
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("SidePanel must be rendered inside AppShell");
  const folded = shell.folded[side];
  const width = useSyncExternalStore(widths.subscribe, widths.get)[side];
  const ids = useId();
  const tabs = props.tabs;
  const active = tabs ? (tabs.find((t) => t.id === props.tab) ?? tabs[0]) : undefined;
  // Folded, the strip shows the tab shown (or the title) and every tab's badge.
  const strip = tabs
    ? {
        label: active?.label ?? "",
        icon: active?.icon,
        badge: tabs.reduce((sum, t) => sum + (t.badge ?? 0), 0),
        badgeLabel: tabs.find((t) => t.badge)?.badgeLabel,
      }
    : { label: props.title, icon: props.icon, badge: props.badge, badgeLabel: props.badgeLabel };
  const { label, icon, badge, badgeLabel } = strip;
  const toggle = useRef<HTMLButtonElement>(null);
  const setFolded = (value: boolean) => {
    shell.fold(side, value);
    requestAnimationFrame(() => toggle.current?.focus());
  };

  const head = (
    <div className="flex h-(--panel-head-h) shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-2 whitespace-nowrap">
      {tabs ? (
        <Tabs
          tabs={tabs}
          active={active?.id ?? ""}
          ids={ids}
          onChange={(id) => (props as Tabbed).onTabChange(id)}
        />
      ) : (
        <>
          <h2 className={cx("ml-1 font-semibold text-base", props.meta ? "shrink-0" : "truncate")}>
            {props.title}
          </h2>
          {props.meta && (
            <span className="ml-1.5 min-w-0 truncate text-muted-foreground text-xs">
              {props.meta}
            </span>
          )}
        </>
      )}
      <span className="flex-1" />
      {!tabs && props.tools}
      <Button
        asChild
        aria-label={`Hide ${label}`}
        variant="ghost"
        size="sm"
        onClick={() => setFolded(true)}
      >
        <button type="button" ref={folded ? undefined : toggle}>
          {side === "left" ? <PanelLeftClose /> : <PanelRightClose />}
          Hide
        </button>
      </Button>
    </div>
  );

  const body = tabs ? (
    tabs.map((t) => (
      <div
        key={t.id}
        id={`${ids}-panel-${t.id}`}
        role="tabpanel"
        aria-labelledby={`${ids}-tab-${t.id}`}
        hidden={t.id !== active?.id}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {t.content}
      </div>
    ))
  ) : (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{props.children}</div>
  );

  const panel = (
    <aside
      aria-label={tabs ? undefined : label}
      style={{ width: folded ? STRIP : width }}
      className="@container flex shrink-0 flex-col overflow-hidden bg-card"
    >
      {folded && (
        <div className="flex flex-col items-center gap-1.5 py-1.5">
          <button
            ref={toggle}
            type="button"
            aria-label={`Show ${label}`}
            onClick={() => setFolded(false)}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [writing-mode:vertical-rl] [&_svg]:size-3.5"
          >
            {icon}
            Show {label}
          </button>
          {!!badge && <Badge n={badge} label={badgeLabel} />}
        </div>
      )}
      <div className={cx("flex min-h-0 flex-1 flex-col", folded && "hidden")}>
        {head}
        {body}
      </div>
    </aside>
  );
  const seam = <Seam side={side} width={width} folded={folded} />;
  return side === "left" ? (
    <>
      {panel}
      {seam}
    </>
  ) : (
    <>
      {seam}
      {panel}
    </>
  );
}

function Tabs({
  tabs,
  active,
  ids,
  onChange,
}: {
  tabs: SidePanelTab[];
  active: string;
  ids: string;
  onChange(id: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const i = tabs.findIndex((t) => t.id === active);
    const next = tabs[(i + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-tab-${next.id}`)}`)?.focus();
  };
  return (
    <div ref={list} role="tablist" className="flex min-w-0 gap-0.5" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${ids}-tab-${t.id}`}
            aria-controls={`${ids}-panel-${t.id}`}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={t.label}
            onClick={() => onChange(t.id)}
            className={cx(
              "inline-flex h-6.5 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring @max-[260px]:px-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
              on
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t.icon}
            <span className="@max-[260px]:sr-only">{t.label}</span>
            {!!t.badge && <Badge n={t.badge} label={t.badgeLabel} />}
          </button>
        );
      })}
    </div>
  );
}

function Badge({ n, label }: { n: number; label?: string }) {
  return (
    <span
      title={label}
      className="h-4 min-w-4 rounded-full bg-check-solid px-1 text-center font-semibold text-[10.5px] text-check-solid-fg leading-4"
    >
      {n}
      {label && <span className="sr-only">: {label}</span>}
    </span>
  );
}

function Seam({ side, width, folded }: { side: ShellSide; width: number; folded: boolean }) {
  if (folded) return <div className="w-0.5 shrink-0 bg-background" />;
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const seam = event.currentTarget;
    const panel = side === "left" ? seam.previousElementSibling : seam.nextElementSibling;
    if (!panel) return;
    event.preventDefault();
    seam.setPointerCapture(event.pointerId);
    const rect = panel.getBoundingClientRect();
    const at = (e: PointerEvent) =>
      side === "left" ? e.clientX - rect.left : rect.right - e.clientX;
    const move = (e: PointerEvent) => widths.set(side, at(e), false);
    const up = (e: PointerEvent) => {
      widths.set(side, at(e), true);
      seam.removeEventListener("pointermove", move);
      seam.removeEventListener("pointerup", up);
      seam.removeEventListener("pointercancel", up);
    };
    seam.addEventListener("pointermove", move);
    seam.addEventListener("pointerup", up);
    seam.addEventListener("pointercancel", up);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> can't take focus or pointer drags
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${side} side`}
      aria-valuenow={width}
      aria-valuemin={WIDTH[side].min}
      aria-valuemax={WIDTH[side].max}
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const wider = (e.key === "ArrowRight") === (side === "left");
        widths.set(side, width + (wider ? 16 : -16), true);
      }}
      className="relative w-[5px] shrink-0 cursor-col-resize touch-none bg-background outline-none after:absolute after:top-1/2 after:left-0.5 after:-mt-3.5 after:h-7 after:w-px after:bg-line-strong hover:bg-select-tint focus-visible:bg-select-tint"
    />
  );
}

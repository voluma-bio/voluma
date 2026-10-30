/**
 * The one list part. A `List` lays out `Row`s on one column grid; a row shows a title, a
 * subtitle, an optional status and cells, and opens in place to its next layer (`children`),
 * indented on a guide line. `RowLink` is a row that is a place: the whole row navigates, and its
 * chevron still opens the next layer. Lists inside an open row take the nested look on their own.
 *
 * Each row's title is its one control (a button, or the link), stretched over the whole row, so
 * the row is a single target without nesting controls. Buttons and links inside cells stay
 * clickable above it. Arrow keys move between rows; Enter opens or follows the focused one.
 */
import { ArrowRight, ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import { cx } from "./cx";

export type Density = "comfortable" | "compact";

/**
 * Where a row goes: a plain URL, or your router's link rendered with the props given (spread them
 * on the link: they carry the row's look and keyboard hook).
 */
export type LinkTo = string | ((props: LinkRenderProps) => ReactNode);
export type LinkRenderProps = {
  className: string;
  children: ReactNode;
  "data-row-control": "";
};

const ListContext = createContext<{ density: Density; nested: boolean } | null>(null);

export type ListProps = {
  /** Grid tracks for the cells after the title (status first, if rows have one), e.g. `"110px 80px"`. */
  columns?: string;
  /** `compact` is 30 px rows with the subtitles hidden. Nested lists inherit it. */
  density?: Density;
  /** Draws a border around a list that sits alone; a list filling a panel needs none. */
  boxed?: boolean;
  /** Accessible name for the list. */
  label?: string;
  className?: string;
  children: ReactNode;
};

export function List({ columns = "", density, boxed, label, className, children }: ListProps) {
  const parent = useContext(ListContext);
  const nested = parent !== null;
  const value = { density: density ?? parent?.density ?? "comfortable", nested };
  return (
    <ListContext.Provider value={value}>
      {/* biome-ignore lint/a11y/useSemanticElements: rows lay out on a grid, not as list bullets */}
      <div
        role="list"
        aria-label={label}
        onKeyDown={moveRowFocus}
        style={{ "--cols": `16px minmax(0, 1fr) ${columns}` } as CSSProperties}
        className={cx(
          "bg-card",
          nested && "mt-3 border-y border-border",
          boxed && "overflow-hidden rounded-lg border border-border",
          className,
        )}
      >
        {children}
      </div>
    </ListContext.Provider>
  );
}

/**
 * Up and Down move focus between the rows' controls under the handler's element, nested rows
 * included. Shared with `Table`.
 */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const target = event.target as HTMLElement;
  if (!target.matches("[data-row-control]")) return;
  const all = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row-control]")];
  const next = all[all.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
}

type OpenProps = {
  /** The next layer, shown below the row when it is open. A row without one has no chevron. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Open state, controlled when `open` is given. Shared with `Disclosure`. */
export function useOpen({ open, defaultOpen = false, onOpenChange }: OpenProps) {
  const [own, setOwn] = useState(defaultOpen);
  const value = open ?? own;
  const set = (next: boolean) => {
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return [value, set] as const;
}

type RowBaseProps = OpenProps & {
  title: ReactNode;
  /** One line under the title; hidden in compact lists. */
  subtitle?: ReactNode;
  /** The row's status (a StatusMark), in the first cell after the title. */
  status?: ReactNode;
  /** Cells after the status, laid out by the list's `columns`. */
  cells?: ReactNode[];
  /** Selection drives the other views; drawn as an ice outline. */
  selected?: boolean;
  className?: string;
};

export type RowProps = RowBaseProps & {
  /** Called when the row is clicked or Entered, as well as opening it. */
  onSelect?: () => void;
};

export function Row({ onSelect, ...props }: RowProps) {
  const [open, setOpen] = useOpen(props);
  const bodyId = useId();
  const expandable = props.children !== undefined;
  const control = expandable || onSelect !== undefined;
  return (
    <RowFrame
      {...props}
      open={open}
      bodyId={bodyId}
      interactive={control}
      lead={expandable && <Chevron open={open} />}
      title={
        control ? (
          <button
            type="button"
            data-row-control=""
            aria-expanded={expandable ? open : undefined}
            aria-controls={expandable && open ? bodyId : undefined}
            aria-current={props.selected || undefined}
            onClick={() => {
              onSelect?.();
              if (expandable) setOpen(!open);
            }}
            className={cx(titleClass, stretchedClass, "cursor-pointer text-left")}
          >
            {props.title}
          </button>
        ) : (
          <span className={titleClass}>{props.title}</span>
        )
      }
    />
  );
}

export type RowLinkProps = RowBaseProps & {
  /** Where the row goes. */
  to: LinkTo;
};

export function RowLink({ to, ...props }: RowLinkProps) {
  const [open, setOpen] = useOpen(props);
  const bodyId = useId();
  const expandable = props.children !== undefined;
  const linkProps: LinkRenderProps = {
    className: cx(titleClass, stretchedClass),
    children: props.title,
    "data-row-control": "",
  };
  return (
    <RowFrame
      {...props}
      open={open}
      bodyId={bodyId}
      interactive
      lead={
        expandable && (
          <button
            type="button"
            aria-label={open ? "Show less" : "Show more"}
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => setOpen(!open)}
            className="relative z-[1] -ml-1 grid size-[22px] cursor-pointer place-items-center rounded-sm hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Chevron open={open} />
          </button>
        )
      }
      title={typeof to === "string" ? <a href={to} {...linkProps} /> : to(linkProps)}
      trail={
        <ArrowRight
          aria-hidden
          className="size-3.5 text-fg-subtle opacity-0 transition-opacity group-hover/row:opacity-100 motion-reduce:transition-none"
        />
      }
    />
  );
}

/** The title's look, whichever element carries it. */
const titleClass = "block max-w-full truncate font-medium text-foreground";
/** Stretches a row's control over its whole row; the focus ring draws around the row. */
export const stretchedClass = cx(
  "after:absolute after:inset-0 after:content-['']",
  "focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring",
);
/**
 * Lifts the controls inside a cell above the row's stretched control (not the row's own control,
 * which `Table` puts in its first cell: positioning it would shrink its stretch to the cell).
 */
export const raiseControls =
  "[&_:is(a,button,input,select,textarea,[tabindex]):not([data-row-control])]:relative [&_:is(a,button,input,select,textarea,[tabindex]):not([data-row-control])]:z-[1]";
const cellClass = cx("flex min-w-0 items-center gap-2", raiseControls);

export function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={cx(
        "size-3.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none",
        open ? "rotate-90 text-foreground" : "text-fg-subtle",
      )}
    />
  );
}

function RowFrame({
  title,
  subtitle,
  status,
  cells = [],
  selected,
  className,
  children,
  open,
  bodyId,
  interactive,
  lead,
  trail,
}: RowBaseProps & {
  open: boolean;
  bodyId: string;
  interactive: boolean;
  lead: ReactNode;
  trail?: ReactNode;
}) {
  const list = useContext(ListContext);
  const compact = list?.density === "compact";
  const nested = list?.nested ?? false;
  return (
    // biome-ignore lint/a11y/useSemanticElements: see List
    <div role="listitem" className={cx("border-border [&+&]:border-t", className)}>
      <div
        className={cx(
          "group/row relative grid auto-cols-[16px] grid-flow-col items-center gap-3 [grid-template-columns:var(--cols)]",
          compact
            ? "min-h-(--row-compact-h) py-[3px]"
            : nested
              ? "min-h-8 py-1"
              : "min-h-(--row-h) py-[5px]",
          nested ? "px-0" : "px-4",
          interactive &&
            (nested
              ? "hover:bg-accent hover:shadow-[-8px_0_0_var(--accent),8px_0_0_var(--accent)]"
              : "hover:bg-accent"),
          selected && "bg-select-tint inset-ring inset-ring-select-dim hover:bg-select-tint",
        )}
      >
        <span className="flex items-center justify-center">{lead}</span>
        <div className="min-w-0">
          {title}
          {subtitle && !compact && (
            <div className="truncate text-sm text-fg-subtle">{subtitle}</div>
          )}
        </div>
        {status !== undefined && <div className={cellClass}>{status}</div>}
        {cells.map((cell, i) => (
          // Cells are positional: the list's columns name them.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
          <div key={i} className={cellClass}>
            {cell}
          </div>
        ))}
        {trail && <span className="flex items-center justify-end">{trail}</span>}
      </div>
      {children !== undefined && open && (
        <div
          id={bodyId}
          className={cx(
            rowBodyClass,
            nested ? "pl-7 before:left-[7px]" : "pr-4 pl-11 before:left-[23px]",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The open layer, on a guide line under the chevron (the caller sets the indent). Shared with `Table`. */
export const rowBodyClass =
  "relative pt-1 pb-4 before:absolute before:top-0 before:bottom-4 before:w-px before:bg-line-strong before:content-['']";

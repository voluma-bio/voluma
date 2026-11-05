/**
 * Final outputs, the input page's right side: a list on top, the selected output's details below,
 * each scrolling on its own with a bar between them to resize. The list holds the run's values in
 * main's sections (and "Not in the workflow"), then "Steps behind the values": every other output
 * published. Every row is one line, and clicking any output's name, in the list or in the details,
 * makes it the selection (`onPick`); the panes show it. The details: its value and what it is, the
 * version with its report, its own To check items, a line to each output it rests on that has open
 * items, and "Based on" (folded, last: Jimmy, Nov 4, "probably not that important to a researcher").
 *
 * While the run goes, a value not in yet shows its chain ticking off as its links are published
 * (`OutputRow.chain`). The list never changes size when something is selected or decided, so
 * nothing moves under the pointer.
 *
 * Data: `outputsReview` (`@voluma/run-view`); review.md "Panels and views".
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { LinkRole } from "@voluma/contracts/output-catalog";
import {
  type ChainLink,
  OUTPUT_STATUS,
  type OutputItem,
  type OutputRow,
  type OutputsReview,
  openItemsOf,
  ROLE_WORD,
  rowStatus,
  type TrailRow,
} from "@voluma/run-view";
import { cx, EmptyState, StatusGlyph } from "@voluma/ui";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { type Accepting, Items, Report, VersionLine } from "./version-report";

export type FinalOutputsProps = {
  review: OutputsReview;
  /** The output the details show and the panes show. */
  current: OutputRow | undefined;
  /** Makes an output the selection, wherever its name was clicked. */
  onPick: (id: string) => void;
  /** Only the rows with an open To check item of their own. */
  onlyToCheck: boolean;
  /** The run has not ended. */
  live: boolean;
  runId: string;
  events: readonly RunEvent[];
  nameOf: (id: string) => string;
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
};

// An output's own open items, as the head's To check counts them (`OutputsReview.open`: only those
// of outputs a value rests on), so the sections add up to the head.
const ownItems = (review: OutputsReview, r: OutputRow) =>
  r.items.filter((i) => i.output === r.id && review.open.has(i.key));

export function FinalOutputs(props: FinalOutputsProps) {
  const { review, current, live } = props;
  const [listHeight, setListHeight] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  if (review.sections.length === 0 && review.undeclared.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={live ? "No outputs listed yet" : "No outputs were recorded"}>
          {live ? "The final outputs show here once the AI has set them up." : undefined}
        </EmptyState>
      </div>
    );
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-24 shrink-0 overflow-y-auto pb-2"
        style={{ height: listHeight ?? "45%" }}
      >
        <OutputList {...props} />
      </div>
      <Divider box={box} height={listHeight} onHeight={setListHeight} />
      {current && <Details key={current.id} row={current} {...props} />}
    </div>
  );
}

/** The bar between the list and the details: drag it, or focus it and use ↑ ↓. */
function Divider({
  box,
  height,
  onHeight,
}: {
  box: React.RefObject<HTMLDivElement | null>;
  height: number | undefined;
  onHeight: (h: number) => void;
}) {
  const clamp = (h: number) => {
    const total = box.current?.clientHeight ?? 600;
    return Math.round(Math.min(Math.max(h, 96), total - 160));
  };
  const now = () => height ?? (box.current?.clientHeight ?? 600) * 0.45;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA splitter pattern; <hr> takes no focus.
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the list and the details"
      aria-valuenow={Math.round(now())}
      tabIndex={0}
      onPointerDown={(e) => {
        const bar = e.currentTarget;
        bar.setPointerCapture(e.pointerId);
        const top = box.current?.getBoundingClientRect().top ?? 0;
        const move = (ev: PointerEvent) => onHeight(clamp(ev.clientY - top));
        bar.addEventListener("pointermove", move);
        bar.addEventListener("pointerup", () => bar.removeEventListener("pointermove", move), {
          once: true,
        });
      }}
      onKeyDown={(e) => {
        const by = e.key === "ArrowUp" ? -24 : e.key === "ArrowDown" ? 24 : 0;
        if (!by) return;
        e.preventDefault();
        onHeight(clamp(now() + by));
      }}
      className="relative h-[5px] shrink-0 cursor-row-resize touch-none border-border border-y bg-background outline-none after:absolute after:top-px after:left-1/2 after:-ml-3.5 after:h-px after:w-7 after:bg-line-strong hover:bg-select-tint focus-visible:bg-select-tint"
    />
  );
}

function OutputList(props: FinalOutputsProps) {
  const { review, onlyToCheck } = props;
  const keep = (rows: OutputRow[]) =>
    onlyToCheck ? rows.filter((r) => ownItems(review, r).length > 0) : rows;
  // Every published output that is not a value: what the values were made from.
  const steps = [...review.rows.values()].filter(
    (r) => r.state.latest && !r.state.final && r.state.declared,
  );
  const groups = [
    ...review.sections.map((s) => ({ title: s.title, rows: s.rows, steps: false })),
    { title: "Not in the workflow", rows: review.undeclared, steps: false },
    { title: "Steps behind the values", rows: steps, steps: true },
  ]
    .map((g) => ({ ...g, all: g.rows, rows: keep(g.rows) }))
    .filter((g) => g.rows.length > 0);
  if (groups.length === 0)
    return <p className="m-0 p-4 text-muted-foreground text-sm">Nothing to check.</p>;
  return groups.map((g) => (
    <Section
      key={g.title}
      {...props}
      title={g.title}
      rows={g.rows}
      all={g.all}
      steps={g.steps}
      opens={
        onlyToCheck ||
        g.rows.some((r) => r.id === props.current?.id) ||
        (!g.steps && g.rows.some((r) => openItemsOf(r).length > 0))
      }
    />
  ));
}

function Section({
  title,
  rows,
  all,
  steps,
  opens,
  ...props
}: FinalOutputsProps & {
  title: string;
  rows: OutputRow[];
  all: OutputRow[];
  steps: boolean;
  opens: boolean;
}) {
  // Opens by itself when it comes to hold the selection or an item; a click overrides until then.
  const [toggled, setToggled] = useState<{ when: boolean; open: boolean }>();
  const open = toggled && toggled.when === opens ? toggled.open : opens;
  const toCheck = rows.reduce((n, r) => n + ownItems(props.review, r).length, 0);
  return (
    <section aria-label={title} className={cx(steps && "mt-1.5 border-border border-t")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled({ when: opens, open: !open })}
        className={cx(
          "sticky top-0 z-1 flex h-8 w-full cursor-pointer items-center gap-1.5 bg-card px-3 text-left text-sm hover:bg-accent",
          steps ? "text-muted-foreground" : "font-semibold",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">{title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 font-normal text-xs">
          {toCheck > 0 ? (
            <>
              <StatusGlyph status="check" />
              <span className="text-check">{toCheck} to check</span>
            </>
          ) : (
            <span className="text-muted-foreground">{all.length}</span>
          )}
        </span>
      </button>
      {open && (
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <li key={r.id}>
              <OutputLine row={r} {...props} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What a row's mark says: its own checks, else whether it is in. */
function markOf(
  review: OutputsReview,
  row: OutputRow,
  live: boolean,
  nameOf: (id: string) => string,
) {
  if (ownItems(review, row).length > 0)
    return { status: "check" as const, word: OUTPUT_STATUS["to-check"].word };
  return rowStatus(row, live, nameOf);
}

/** One output on one line: its mark, its name, then its value or how many to check. */
function OutputLine({
  row,
  review,
  current,
  onPick,
  live,
  nameOf,
  right,
  className,
}: Pick<FinalOutputsProps, "review" | "current" | "onPick" | "live" | "nameOf"> & {
  row: OutputRow;
  /** In place of the value: a role in Based on. */
  right?: ReactNode;
  className?: string;
}) {
  const { status, word } = markOf(review, row, live, nameOf);
  const selected = row.id === current?.id;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const open = ownItems(review, row).length;
  return (
    <button
      ref={ref}
      type="button"
      aria-current={selected || undefined}
      onClick={() => onPick(row.id)}
      className={cx(
        "relative flex h-7 w-full cursor-pointer items-center gap-2 pr-3 pl-8 text-left text-sm",
        selected
          ? "bg-select-tint before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-select"
          : "hover:bg-accent",
        className,
      )}
    >
      <span title={word} className="shrink-0">
        <StatusGlyph status={status} />
        <span className="sr-only">{word}</span>
      </span>
      <span className={cx("min-w-0 truncate", row.state.outOfDate && "line-through")}>
        {row.name}
      </span>
      {row.provisional && (
        <span className="shrink-0 rounded-sm px-1 font-mono text-[11px] text-muted-foreground inset-ring inset-ring-border">
          provisional
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-2 whitespace-nowrap">
        {right}
        {right === undefined &&
          (row.value ? (
            <span className="font-mono text-sm tabular-nums">
              {row.value.text}
              {row.value.unit && (
                <span className="text-muted-foreground text-xs"> {row.value.unit}</span>
              )}
            </span>
          ) : open > 0 ? (
            <span className="text-check text-xs">{open} to check</span>
          ) : (
            !row.state.latest && <span className="text-muted-foreground text-xs">{word}</span>
          ))}
      </span>
    </button>
  );
}

const ROLE_ORDER: LinkRole[] = ["on", "context", "input", "base"];

/** The selection: what it is, its version and report, what to check, and what it is based on. */
function Details({ row, ...props }: FinalOutputsProps & { row: OutputRow }) {
  const { nameOf, live } = props;
  const [report, setReport] = useState(false);
  const latest = row.state.latest;
  const own = ownItems(props.review, row);
  const waits = rowStatus(row, live, nameOf)
    .waits.map((id) => ({
      id,
      count: row.items.filter((i) => i.output === id && props.review.open.has(i.key)).length,
    }))
    .filter((w) => w.count > 0);
  const restsOn = row.trail
    .filter((r) => r.depth === 1)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role ?? "base") - ROLE_ORDER.indexOf(b.role ?? "base"));
  return (
    <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto px-3 pt-3 pb-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <div className="flex items-baseline gap-3">
          <h3
            className={cx(
              "m-0 min-w-0 font-semibold text-base",
              row.state.outOfDate && "line-through",
            )}
          >
            {row.name}
          </h3>
          {row.value && (
            <span className="ml-auto shrink-0 font-mono text-lg tabular-nums whitespace-nowrap">
              {row.value.text}
              {row.value.unit && (
                <span className="text-muted-foreground text-xs"> {row.value.unit}</span>
              )}
            </span>
          )}
        </div>
        {row.description && <p className="m-0 text-muted-foreground text-sm">{row.description}</p>}
      </div>
      {latest ? (
        <VersionLine v={latest}>
          <button
            type="button"
            aria-expanded={report}
            onClick={() => setReport(!report)}
            className="cursor-pointer text-primary-text hover:underline"
          >
            {report ? "Hide report" : "Report"}
          </button>
        </VersionLine>
      ) : (
        <p className="m-0 text-muted-foreground text-xs">
          {row.state.missingReason ?? rowStatus(row, live, nameOf).word}
        </p>
      )}
      {row.provisional && (
        <p className="m-0 text-muted-foreground text-xs">
          Provisional: no reference comparison yet
        </p>
      )}
      {/* Before its trail is published, what it will rest on. */}
      {live && restsOn.length === 0 && <ChainLine chain={row.chain} nameOf={nameOf} />}
      {report && latest && (
        <div className="border-select border-l-2 pl-2.5">
          <Report
            runId={props.runId}
            events={props.events}
            v={latest}
            outOfDate={row.state.outOfDate}
            nameOf={nameOf}
            madeFrom={false}
          />
        </div>
      )}
      {(own.length > 0 || waits.length > 0) && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {own.length > 0 && <Items {...props} items={own} own={row.id} />}
          {waits.map(({ id, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => props.onPick(id)}
              className="flex cursor-pointer items-center gap-1.5 justify-self-start rounded-sm text-left text-check text-xs hover:underline"
            >
              <StatusGlyph status="check" />
              {count} to check on {nameOf(id)}, which this rests on
              <ChevronRight aria-hidden className="size-3.5 shrink-0" />
            </button>
          ))}
        </div>
      )}
      {restsOn.length > 0 && (
        <BasedOn
          {...props}
          rows={row.trail}
          restsOn={restsOn}
          further={row.trail.filter((r) => r.depth > 1)}
        />
      )}
    </div>
  );
}

/** "Based on": folded to one line naming what it rests on; open, the same rows as the list. */
function BasedOn({
  rows,
  restsOn,
  further,
  ...props
}: FinalOutputsProps & { rows: TrailRow[]; restsOn: TrailRow[]; further: TrailRow[] }) {
  const { nameOf } = props;
  const [open, setOpen] = useState(false);
  const [showFurther, setShowFurther] = useState(false);
  // Which row a row further back feeds: the first, nearest the value, that links it.
  const feeds = (r: TrailRow) => {
    const at = rows.indexOf(r);
    const parent = rows.find((p) => p.from.includes(at));
    return parent ? nameOf(parent.id) : undefined;
  };
  const line = (r: TrailRow, words: ReactNode) => {
    const full = props.review.rows.get(r.id);
    if (!full) return null;
    return (
      <li key={r.id}>
        <OutputLine
          row={full}
          {...props}
          className="rounded-sm pl-2"
          right={
            <span className="text-muted-foreground text-xs">
              {words}
              {r.superseded &&
                full.state.latest &&
                `, used v${r.used} of ${full.state.latest.version}`}
            </span>
          }
        />
      </li>
    );
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 border-border border-t pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm text-left text-muted-foreground text-sm hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0">Based on</span>
        {!open && (
          <span className="min-w-0 truncate text-xs">
            {restsOn.map((r) => nameOf(r.id)).join(", ")}
          </span>
        )}
      </button>
      {open && (
        <ul className="m-0 list-none p-0">
          {restsOn.map((r) => line(r, r.role && ROLE_WORD[r.role]))}
          {further.length > 0 && (
            <li>
              <button
                type="button"
                aria-expanded={showFurther}
                onClick={() => setShowFurther(!showFurther)}
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm pl-2 text-left text-muted-foreground text-sm hover:bg-accent"
              >
                <ChevronRight
                  aria-hidden
                  className={cx(
                    "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
                    showFurther && "rotate-90",
                  )}
                />
                Earlier steps
                <span className="ml-auto pr-3 text-xs">{further.length}</span>
              </button>
            </li>
          )}
          {showFurther &&
            further.map((r) => {
              const to = feeds(r);
              return line(
                r,
                [r.role && ROLE_WORD[r.role], to && `for ${to}`].filter(Boolean).join(" "),
              );
            })}
        </ul>
      )}
    </div>
  );
}

/**
 * "Based on ○ Patella ‹ ○ Bone labels ‹ ✓ Scan": the chain a value not in yet is computed on,
 * nearest first, each link hollow until a version of it is published. Several at one step read "A, B".
 */
function ChainLine({ chain, nameOf }: { chain: ChainLink[][]; nameOf: (id: string) => string }) {
  if (chain.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
      <span className="mr-0.5">Based on</span>
      {chain.map((step, i) => (
        <Fragment key={step.map((l) => l.id).join()}>
          {i > 0 && (
            <span aria-hidden className="text-fg-subtle">
              ‹
            </span>
          )}
          {step.map((link, j) => {
            const { status, word } = link.status
              ? OUTPUT_STATUS[link.status]
              : { status: "waiting" as const, word: "not yet" };
            return (
              <span key={link.id} className="inline-flex items-center gap-1">
                <span title={word}>
                  <StatusGlyph status={status} className="size-3" />
                  <span className="sr-only">{word}</span>
                </span>
                {nameOf(link.id)}
                {j < step.length - 1 && ","}
              </span>
            );
          })}
        </Fragment>
      ))}
    </p>
  );
}

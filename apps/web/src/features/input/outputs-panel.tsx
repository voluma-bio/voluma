/**
 * Final outputs, the input page's right side: a run of the agent loop's final values in main's
 * sections, then the outputs a worker reported that the workflow does not declare. The value
 * picked opens in place under its row: what it is, who made it, its report, its To check items
 * (with those of what it rests on), and "Rests on": the outputs its latest version was measured on,
 * drawn beside, made from or drawn on, with "Further back" opening the rest of its history in the
 * same list. A row there frames the panes on that output and opens its report under it. The
 * whole run's graph (W) is the place for what rests on an output. Lists separate by spacing.
 *
 * While the run goes, each value's "rests on" chain ticks off as its links are published
 * (`OutputRow.chain`), and "Other outputs so far" lists what else is published
 * (`OutputsReview.others`). Once the run ends neither shows: the panel is the review.
 *
 * Data: `outputsReview` (`@voluma/run-view`); review.md "Panels and views".
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { LinkRole } from "@voluma/contracts/output-catalog";
import { hasVersion, type OutputStatus } from "@voluma/contracts/output-fold";
import {
  type ChainLink,
  itemsOfVersion,
  type OutputItem,
  type OutputRow,
  type OutputsReview,
  openItemsOf,
  ROLE_WORD,
  rowsToCheck,
  type TrailRow,
} from "@voluma/run-view";
import { cx, EmptyState, type Status, StatusGlyph } from "@voluma/ui";
import { ChevronRight } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { type Accepting, clockOf, Items, Report, VersionLine } from "./version-report";

/** Each output status on the shared status marks, in the design's words. */
export const OUTPUT_STATUS: Record<OutputStatus, { status: Status; word: string }> = {
  pending: { status: "waiting", word: "Pending" },
  reported: { status: "done", word: "Reported" },
  "to-check": { status: "check", word: "To check" },
  missing: { status: "stopped", word: "Missing" },
  "out-of-date": { status: "paused", word: "Out of date" },
};

/** A row's status; while the run goes, nothing published yet reads "not yet". */
export const statusOf = (row: OutputRow, live: boolean) =>
  live && row.state.status === "pending"
    ? { ...OUTPUT_STATUS.pending, word: "not yet" }
    : OUTPUT_STATUS[row.state.status];

/** A reported value whose own status is fine but which rests on an open To check item. */
export const restsOnOpen = (row: OutputRow) =>
  row.state.status === "reported" && openItemsOf(row).some((i) => i.output !== row.id);

export type FinalOutputsProps = {
  review: OutputsReview;
  /** The value open in place. */
  selected: OutputRow | undefined;
  onSelect: (id: string) => void;
  /** The output of its history whose report is open and whose output the panes show. */
  open: string | undefined;
  onOpen: (id: string | null) => void;
  /** Only the rows with an open To check item (`rowsToCheck`). */
  onlyToCheck: boolean;
  /** The run has not ended: the panel adds what a run going shows. */
  live: boolean;
  runId: string;
  events: readonly RunEvent[];
  nameOf: (id: string) => string;
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
};

export function FinalOutputs(props: FinalOutputsProps) {
  const { review, live, open } = props;
  const others = live ? review.others : [];
  // An output open from Other outputs opens there, not also under the value.
  const openOther = others.some((r) => r.id === open);
  return (
    <>
      <Values {...props} open={openOther ? undefined : open} />
      {others.length > 0 && <OtherOutputs {...props} rows={others} />}
    </>
  );
}

function Values(props: FinalOutputsProps) {
  const { review, selected, onlyToCheck, live } = props;
  const { sections, undeclared } = review;
  if (sections.length === 0 && undeclared.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={live ? "No outputs listed yet" : "No outputs were recorded"}>
          {live ? "The final outputs show here once the AI has set them up." : undefined}
        </EmptyState>
      </div>
    );
  const checking = onlyToCheck ? rowsToCheck(review) : undefined;
  const groups = checking
    ? [
        ...sections.map((s) => ({ ...s, rows: s.rows.filter((r) => checking.listed.includes(r)) })),
        {
          title: "Not in the workflow",
          rows: undeclared.filter((r) => checking.listed.includes(r)),
        },
        { title: "Behind the values", rows: checking.behind },
      ].filter((s) => s.rows.length > 0)
    : [
        ...sections,
        ...(undeclared.length > 0 ? [{ title: "Not in the workflow", rows: undeclared }] : []),
      ];
  if (groups.length === 0)
    return <p className="m-0 p-4 text-muted-foreground text-sm">Nothing to check.</p>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 py-1.5">
      {groups.map((s) => (
        <Section
          key={s.title}
          {...props}
          title={s.title}
          rows={s.rows}
          opens={
            onlyToCheck || s.rows.some((r) => r.id === selected?.id || openItemsOf(r).length > 0)
          }
        />
      ))}
    </div>
  );
}

function Section({
  title,
  rows,
  opens,
  ...props
}: FinalOutputsProps & {
  title: string;
  rows: OutputRow[];
  opens: boolean;
}) {
  // Opens by itself when it comes to hold the selection or an item; a click overrides until then.
  const [toggled, setToggled] = useState<{ when: boolean; open: boolean }>();
  const open = toggled && toggled.when === opens ? toggled.open : opens;
  const toCheck = new Set(rows.flatMap((r) => openItemsOf(r).map((i) => i.key))).size;
  // While the run goes, a tick only once every row has a version (the panel head counts them).
  const notIn = props.live ? rows.filter((r) => !hasVersion(r.state)).length : 0;
  const first = rows.find((r) => r.value);
  return (
    <section aria-label={title} className="grid grid-cols-[minmax(0,1fr)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled({ when: opens, open: !open })}
        className="flex h-8 cursor-pointer items-center gap-1.5 px-3 text-left text-sm hover:bg-accent"
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 font-semibold">{title}</span>
        {!open && first?.value && (
          <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
            {first.name} {first.value.text} {first.value.unit}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs">
          {toCheck > 0 ? (
            <>
              <StatusGlyph status="check" />
              <span className="text-check">{toCheck} to check</span>
            </>
          ) : notIn > 0 ? null : (
            <>
              <StatusGlyph status="done" />
              <span className="text-muted-foreground">{rows.length}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] p-0">
          {rows.map((r) =>
            r.id === props.selected?.id ? (
              <Opened key={r.id} row={r} {...props} />
            ) : (
              <li key={r.id}>
                <ValueRow row={r} live={props.live} onSelect={() => props.onSelect(r.id)} />
                {props.live && <ChainLine chain={r.chain} nameOf={props.nameOf} />}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function ValueRow({
  row,
  live,
  selected = false,
  bar = false,
  onSelect,
}: {
  row: OutputRow;
  live: boolean;
  selected?: boolean;
  /** The selection's blue bar: while nothing under it is open. */
  bar?: boolean;
  onSelect: () => void;
}) {
  const { status, word } = statusOf(row, live);
  const ref = useScrolledTo(selected);
  return (
    <button
      ref={ref}
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cx(
        "relative flex h-[26px] w-full cursor-pointer items-center gap-2 pr-3 pl-5 text-left text-sm",
        selected ? "bg-select-tint" : "hover:bg-accent",
        bar && "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-select",
      )}
    >
      <span title={word}>
        <StatusGlyph status={status} />
        <span className="sr-only">{word}</span>
      </span>
      <span className={cx("min-w-0 truncate", row.state.outOfDate && "line-through")}>
        {row.name}
      </span>
      {restsOnOpen(row) && (
        <span className="shrink-0 truncate text-muted-foreground text-xs">rests on a To check</span>
      )}
      {row.provisional && (
        <span className="shrink-0 rounded-sm px-1 font-mono text-[11px] text-muted-foreground inset-ring inset-ring-border">
          provisional
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-sm tabular-nums whitespace-nowrap">
        {row.value ? (
          <>
            {row.value.text}
            {row.value.unit && (
              <span className="text-muted-foreground text-xs"> {row.value.unit}</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground text-xs">{word}</span>
        )}
      </span>
    </button>
  );
}

/** Brings the row into view when it becomes the selection, only if it is out of view. */
function useScrolledTo(active: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return ref;
}

const ROLE_ORDER: LinkRole[] = ["on", "context", "input", "base"];

/** The value open in place: what it is, its version, report and items, and what it rests on. */
function Opened({ row, ...props }: FinalOutputsProps & { row: OutputRow }) {
  const { open, nameOf } = props;
  const [report, setReport] = useState(false);
  const trail = row.trail;
  const latest = row.state.latest;
  const openItems = row.items.filter((i) => !i.resolved);
  const shown = openItems.filter((i) => i.output !== open);
  const below = openItems.length - shown.length;
  const restsOn = trail
    .filter((r) => r.depth === 1)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role ?? "base") - ROLE_ORDER.indexOf(b.role ?? "base"));
  const further = trail.filter((r) => r.depth > 1);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] bg-select-tint pb-2.5">
      <ValueRow
        row={row}
        live={props.live}
        selected
        bar={!open}
        onSelect={() => props.onOpen(null)}
      />
      {/* Before its trail is published, what it will rest on. */}
      {props.live && restsOn.length === 0 && <ChainLine chain={row.chain} nameOf={nameOf} />}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 pr-3 pl-9">
        {row.description && <p className="m-0 text-muted-foreground text-sm">{row.description}</p>}
        {latest ? (
          <VersionLine v={latest}>
            {latest.kept && <span>kept: {latest.kept.reason}</span>}
            <button
              type="button"
              aria-expanded={report}
              onClick={() => setReport(!report)}
              className="cursor-pointer text-primary-text hover:underline"
            >
              Report
            </button>
          </VersionLine>
        ) : (
          <p className="m-0 text-muted-foreground text-xs">
            {row.state.missingReason ?? statusOf(row, props.live).word}
          </p>
        )}
        {row.provisional && (
          <p className="m-0 text-muted-foreground text-xs">
            Provisional: no reference comparison yet
          </p>
        )}
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
        {/* Open items only; an open row below shows its own, so here they shrink to a line. */}
        {shown.length > 0 && <Items {...props} items={shown} own={row.id} />}
        {below > 0 && open && (
          <p className="m-0 flex items-center gap-1.5 text-check text-xs">
            <StatusGlyph status="check" />
            {below} to check on {nameOf(open)}, open below
          </p>
        )}
        {restsOn.length > 0 && (
          <RestsOn {...props} rows={trail} restsOn={restsOn} further={further} />
        )}
      </div>
    </li>
  );
}

function RestsOn({
  rows,
  restsOn,
  further,
  ...props
}: FinalOutputsProps & { rows: TrailRow[]; restsOn: TrailRow[]; further: TrailRow[] }) {
  const { open, nameOf } = props;
  // Further back opens by itself when the output open is one of its rows; a click overrides.
  const holds = further.some((r) => r.id === open);
  const [toggled, setToggled] = useState<{ when: boolean; open: boolean }>();
  const showFurther = toggled && toggled.when === holds ? toggled.open : holds;
  // Which row a row further back feeds: the first, nearest the value, that links it.
  const feeds = (r: TrailRow) => {
    const at = rows.indexOf(r);
    const parent = rows.find((p) => p.from.includes(at));
    return parent ? nameOf(parent.id) : undefined;
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 pt-1">
      <h4 className="m-0 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Rests on
      </h4>
      <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 rounded-md bg-card p-1 inset-ring inset-ring-border">
        {restsOn.map((r) => (
          <TrailItem key={r.id} row={r} {...props} />
        ))}
        {further.length > 0 && (
          <li>
            <button
              type="button"
              aria-expanded={showFurther}
              onClick={() => setToggled({ when: holds, open: !showFurther })}
              className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-sm hover:bg-accent"
            >
              <ChevronRight
                aria-hidden
                className={cx(
                  "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
                  showFurther && "rotate-90",
                )}
              />
              <span className="shrink-0">Further back · {further.length}</span>
              {!showFurther && (
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  {further.map((r) => nameOf(r.id)).join(", ")}
                </span>
              )}
            </button>
          </li>
        )}
        {showFurther &&
          further.map((r) => <TrailItem key={r.id} row={r} feeds={feeds(r)} {...props} />)}
      </ul>
    </div>
  );
}

/** One output a value rests on: two lines, its report under it while open. */
function TrailItem({
  row,
  feeds,
  ...props
}: FinalOutputsProps & { row: TrailRow; feeds?: string }) {
  const { open, nameOf } = props;
  const isOpen = row.id === open;
  const latest = row.state?.latest;
  const status = row.state ? OUTPUT_STATUS[row.state.status] : OUTPUT_STATUS.pending;
  const ref = useScrolledTo(isOpen);
  const items = latest ? itemsOfVersion(row.id, latest) : [];
  return (
    <li className={cx("grid grid-cols-[minmax(0,1fr)] rounded-sm", isOpen && "bg-select-tint")}>
      <button
        ref={ref}
        type="button"
        aria-expanded={isOpen}
        onClick={() => props.onOpen(isOpen ? null : row.id)}
        className={cx(
          "relative grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-sm px-1.5 py-1 text-left text-sm",
          isOpen
            ? "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-select"
            : "hover:bg-accent",
        )}
      >
        <span title={status.word}>
          <StatusGlyph status={status.status} />
          <span className="sr-only">{status.word}</span>
        </span>
        <span className={cx("truncate", row.state?.outOfDate && "line-through")}>
          {nameOf(row.id)}
        </span>
        <span className="text-muted-foreground text-xs">
          {row.role && ROLE_WORD[row.role]}
          {feeds && `, for ${feeds}`}
        </span>
        <span className="col-start-2 col-end-4 flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-xs">
          {row.used !== undefined && (
            <span className="rounded-sm bg-muted px-1 font-mono">v{row.used}</span>
          )}
          {latest && <span className="font-mono">{latest.by}</span>}
          {latest && <span>{clockOf(latest.at)}</span>}
          {row.superseded && latest && <span>v{latest.version} is newest</span>}
          {row.state?.outOfDate && <span>Out of date</span>}
          {row.state && !row.state.declared && (
            <span className="rounded-sm bg-muted px-1">not in the workflow</span>
          )}
          {!latest && <span>{status.word}</span>}
        </span>
      </button>
      {isOpen && latest && (
        <div className="mx-1.5 mb-2 grid grid-cols-[minmax(0,1fr)] gap-2 border-select border-l-2 pt-1 pl-2.5">
          <Report
            runId={props.runId}
            events={props.events}
            v={latest}
            outOfDate={!!row.state?.outOfDate}
            nameOf={nameOf}
          />
          {items.length > 0 && <Items {...props} items={items} own={row.id} />}
        </div>
      )}
    </li>
  );
}

/**
 * "rests on ○ Patella ‹ ○ Bone labels ‹ ✓ Scan": the chain a value is computed on, nearest first,
 * each link hollow until a version of it is published. Several at one step read "A, B".
 */
function ChainLine({ chain, nameOf }: { chain: ChainLink[][]; nameOf: (id: string) => string }) {
  if (chain.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pr-3 pb-1 pl-10 text-muted-foreground text-xs">
      <span className="mr-0.5">rests on</span>
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

/**
 * "Other outputs so far · N" while the run goes: what is published that is neither a final output
 * nor on a value's chain. Each opens like a row of Rests on: its report under it, the panes on it.
 */
function OtherOutputs({ rows, ...props }: FinalOutputsProps & { rows: OutputRow[] }) {
  const holds = rows.some((r) => r.id === props.open);
  const [toggled, setToggled] = useState<{ when: boolean; open: boolean }>();
  const shown = toggled && toggled.when === holds ? toggled.open : holds;
  return (
    <section
      aria-label="Other outputs so far"
      className="grid grid-cols-[minmax(0,1fr)] px-1.5 pb-3"
    >
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setToggled({ when: holds, open: !shown })}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none",
            shown && "rotate-90",
          )}
        />
        Other outputs so far · {rows.length}
      </button>
      {shown && (
        <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
          {rows.map((r) => (
            <TrailItem
              key={r.id}
              row={{ id: r.id, depth: 1, state: r.state, superseded: false, from: [] }}
              {...props}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

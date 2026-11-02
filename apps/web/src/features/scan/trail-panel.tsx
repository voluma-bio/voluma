/**
 * How the AI got here: the trail behind the output in Final outputs (`trailOf`), its made-from
 * graph turned on its side. The root on top with its value, version and To check items; below it
 * what it rests on, one output per row with the role it plays, its version, who made it and when,
 * links drawn as arcs in the left gutter. A row opens its version's report under it and frames
 * the panes on it; the root's row closes it. Out-of-date outputs and versions a newer one replaced
 * are marked on their rows.
 *
 * Plain on purpose: the side panels are being redesigned; the data comes from `outputs-trail.ts`.
 */
import { outputFileUrl } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import type { OutputsFold, OutputVersion } from "@voluma/contracts/output-fold";
import {
  ItemToCheck,
  Markdown,
  type OutputItem,
  type OutputRow,
  ROLE_WORD,
  type TrailRow,
  trailOf,
  versionWords,
} from "@voluma/run-view";
import { Button, cx, StatusGlyph } from "@voluma/ui";
import { Crosshair } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Accepting, OUTPUT_STATUS } from "./outputs-panel";

export const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function TrailPanel({
  runId,
  events,
  fold,
  root,
  open,
  onOpen,
  onReroot,
  nameOf,
  item,
  onItem,
  accepting,
}: {
  runId: string;
  events: readonly RunEvent[];
  fold: OutputsFold;
  /** The output in Final outputs, the trail's root. */
  root: OutputRow;
  /** The trail row whose report is open and whose output the panes show. */
  open: string | undefined;
  onOpen: (id: string | null) => void;
  onReroot: (id: string) => void;
  nameOf: (id: string) => string;
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
}) {
  const rows = useMemo(() => trailOf(fold, root.id), [fold, root.id]);
  const box = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [ys, setYs] = useState<Map<string, number>>(new Map());
  // The arcs follow the rows as reports open and the panel resizes.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      const next = new Map<string, number>();
      for (const [id, a] of anchors.current) {
        const r = a.getBoundingClientRect();
        next.set(id, r.top - top + Math.min(r.height, 30) / 2);
      }
      setYs((had) =>
        had.size === next.size && [...next].every(([k, v]) => had.get(k) === v) ? had : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  const anchor = (id: string) => (el: HTMLElement | null) => {
    if (el) anchors.current.set(id, el);
    else anchors.current.delete(id);
  };

  const [top, ...below] = rows;
  const openCount = root.items.filter((i) => !i.resolved).length;
  return (
    <div ref={box} className="relative grid grid-cols-[minmax(0,1fr)] gap-1 py-3 pr-3 pl-7">
      <Arcs rows={rows} ys={ys} />
      <div ref={anchor(root.id)} className="grid gap-2 rounded-md p-2 inset-ring inset-ring-select">
        <button
          type="button"
          className="flex cursor-pointer items-baseline gap-2 text-left"
          onClick={() => onOpen(null)}
        >
          <StatusGlyph status={OUTPUT_STATUS[root.state.status].status} className="self-center" />
          <span className="min-w-0 font-medium">{root.name}</span>
          {root.value && (
            <span className="ml-auto shrink-0 font-mono text-sm tabular-nums">
              {root.value.text}
              <span className="text-muted-foreground"> {root.value.unit}</span>
            </span>
          )}
        </button>
        {top?.state?.latest && <VersionLine v={top.state.latest} />}
        {root.provisional && (
          <p className="text-xs text-muted-foreground">Provisional: no reference comparison yet</p>
        )}
        {open === undefined && top?.state?.latest && (
          <Report
            runId={runId}
            events={events}
            row={top}
            nameOf={nameOf}
            rootItems={root.items}
            item={item}
            onItem={onItem}
            accepting={accepting}
            open={openCount}
          />
        )}
      </div>
      {below.length > 0 && (
        <h4 className="pt-3 pb-1 text-xs text-muted-foreground">What it rests on</h4>
      )}
      {below.map((r) => {
        const isOpen = r.id === open;
        const latest = r.state?.latest;
        const status = r.state ? OUTPUT_STATUS[r.state.status] : OUTPUT_STATUS.pending;
        return (
          <div key={r.id} className={cx("grid gap-2 rounded-md", isOpen && "bg-muted p-2")}>
            <button
              ref={anchor(r.id)}
              type="button"
              aria-expanded={isOpen}
              onClick={() => onOpen(isOpen ? null : r.id)}
              className="grid min-h-[30px] cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 text-left text-sm hover:bg-accent"
            >
              <span title={status.word}>
                <StatusGlyph status={status.status} />
                <span className="sr-only">{status.word}</span>
              </span>
              <span className="truncate">{nameOf(r.id)}</span>
              <span className="text-xs text-muted-foreground">{r.role && ROLE_WORD[r.role]}</span>
              <span className="col-start-2 col-end-4 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {r.used !== undefined && <span className="font-mono">v{r.used}</span>}
                {latest && <span className="font-mono">{latest.by}</span>}
                {latest && <span>{clockOf(latest.at)}</span>}
                {r.superseded && latest && <span>now v{latest.version}</span>}
                {r.state?.outOfDate && <span>Out of date</span>}
                {!r.state?.declared && r.state && <span>Not in the workflow</span>}
                {!latest && <span>{status.word}</span>}
              </span>
            </button>
            {isOpen && latest && (
              <Report
                runId={runId}
                events={events}
                row={r}
                nameOf={nameOf}
                item={item}
                onItem={onItem}
                accepting={accepting}
                onReroot={() => onReroot(r.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The made-from links as arcs in the left gutter: solid on, dashed beside, dotted drawn on. */
function Arcs({ rows, ys }: { rows: TrailRow[]; ys: Map<string, number> }) {
  const paths = rows.flatMap((r) =>
    r.from.flatMap((f) => {
      const to = rows[f]!;
      const y1 = ys.get(r.id);
      const y2 = ys.get(to.id);
      if (y1 === undefined || y2 === undefined) return [];
      const bend = 4 + Math.min(14, Math.abs(y2 - y1) / 24);
      return [
        <path
          key={`${r.id}>${to.id}`}
          d={`M 22 ${y1} C ${22 - bend * 1.5} ${y1}, ${22 - bend * 1.5} ${y2}, 22 ${y2}`}
          fill="none"
          className="stroke-fg-subtle"
          strokeWidth={1}
          strokeDasharray={to.role === "context" ? "4 3" : to.role === "base" ? "1 3" : undefined}
        />,
      ];
    }),
  );
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 h-full w-6 overflow-visible"
    >
      {paths}
    </svg>
  );
}

function VersionLine({ v }: { v: OutputVersion }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
      <span className="rounded-sm bg-muted px-1 font-mono">v{v.version}</span>
      <span className="font-mono text-foreground">{v.by}</span>
      <span>{clockOf(v.at)}</span>
      {v.kept && <span>kept: {v.kept.reason}</span>}
    </p>
  );
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * A version's report: the worker's own words, the evidence it was checked on, what it was made
 * from, and its To check items (on the root, the items it rests on too).
 */
function Report({
  runId,
  events,
  row,
  nameOf,
  rootItems,
  item,
  onItem,
  accepting,
  open,
  onReroot,
}: {
  runId: string;
  events: readonly RunEvent[];
  row: TrailRow;
  nameOf: (id: string) => string;
  /** On the root: its items and those of what it rests on. */
  rootItems?: OutputItem[];
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
  open?: number;
  onReroot?: () => void;
}) {
  const v = row.state!.latest!;
  const words = useMemo(() => versionWords(events, v), [events, v]);
  const items: OutputItem[] =
    rootItems ??
    v.toCheck.map((t, i) => ({
      key: `${row.id}/${v.version}/${i}`,
      output: row.id,
      version: v.version,
      item: i,
      title: t.title,
      ...(t.focus && { focus: t.focus }),
      resolved: t.resolved !== undefined,
    }));
  const head = "pt-2 text-xs font-medium text-muted-foreground";
  return (
    <div className="grid gap-1.5 text-sm">
      {!rootItems && <VersionLine v={v} />}
      {row.state?.outOfDate && (
        <p>Something it was made from has changed since. The AI keeps it or redoes it.</p>
      )}
      {words && (
        <>
          <h5 className={head}>In its words</h5>
          <Markdown text={words} className="text-sm" />
        </>
      )}
      {v.evidence.length > 0 && (
        <>
          <h5 className={head}>Checked on</h5>
          <div className="flex flex-wrap gap-1.5">
            {v.evidence.map((e) => {
              const url = outputFileUrl(runId, `${v.path}/${e.name}`);
              return IMAGE.test(e.name) ? (
                <a key={e.name} href={url} target="_blank" rel="noreferrer" title={e.name}>
                  <img
                    src={url}
                    alt={e.name}
                    loading="lazy"
                    className="h-16 w-20 rounded-sm bg-viewer-well object-cover"
                  />
                </a>
              ) : (
                <a key={e.name} href={url} className="text-xs underline" download>
                  {e.name.replace(/^evidence\//, "")}
                </a>
              );
            })}
          </div>
        </>
      )}
      {v.madeFrom.length > 0 && (
        <>
          <h5 className={head}>Made from</h5>
          <ul className="grid gap-0.5">
            {v.madeFrom.map((l) => (
              <li key={`${l.id}/${l.version}`} className="flex gap-2 text-sm">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {ROLE_WORD[l.role]}
                </span>
                <span className="min-w-0 truncate">{nameOf(l.id)}</span>
                <span className="font-mono text-xs text-muted-foreground">v{l.version}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {items.length > 0 && (
        <>
          <h5 className={head}>{open ? `${open} to check` : "To check"}</h5>
          {items.map((i) => (
            <ItemToCheck
              key={i.key}
              context={
                i.output === row.id ? nameOf(row.id) : `On ${nameOf(i.output)}, which this rests on`
              }
              title={i.title}
              text=""
              state={i.resolved ? "accepted" : "open"}
              onAccept={accepting.accept && (() => accepting.accept?.(i))}
              accepting={accepting.pending === i.key}
              readOnly={accepting.readOnly}
              error={accepting.error?.key === i.key ? accepting.error.text : undefined}
              className={i.key === item ? "inset-ring-select" : undefined}
              actions={
                i.focus && (
                  <Button variant="ghost" size="sm" onClick={() => onItem(i)}>
                    <Crosshair aria-hidden />
                    Show
                  </Button>
                )
              }
            />
          ))}
        </>
      )}
      {onReroot && (
        <div className="pt-1">
          <Button size="sm" variant="secondary" onClick={onReroot}>
            Trail from here
          </Button>
        </div>
      )}
    </div>
  );
}

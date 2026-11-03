/**
 * The whole run (W), in the panes' place: every output with a version, and every final output, in columns, from what was
 * made from nothing on the left to the final outputs, grouped by section, on the right; links
 * from what an output was made from to it. The output in Final outputs is in the spotlight with
 * what it rests on and what rests on it; the rest is dimmed. Out-of-date outputs are marked.
 * A box picks its output. Data from `runGraph` (`outputs-trail.ts`).
 */
import type { OutputsFold } from "@voluma/contracts/output-fold";
import { madeFromIt, type OutputRow, runGraph } from "@voluma/run-view";
import { cx, StatusGlyph } from "@voluma/ui";
import { useMemo } from "react";
import { OUTPUT_STATUS } from "./outputs-panel";

const COL_W = 176;
const COL_GAP = 56;
const ROW_H = 26;
const ROW_GAP = 6;
const HEAD_H = 22;
const PAD = 16;

export function RunGraphView({
  fold,
  selected,
  onPick,
  rows,
}: {
  fold: OutputsFold;
  /** The output in the spotlight. */
  selected: string | undefined;
  onPick: (id: string) => void;
  /** Names and values, by output id. */
  rows: ReadonlyMap<string, OutputRow>;
}) {
  const nameOf = (id: string) => rows.get(id)?.name ?? id;
  const graph = useMemo(() => runGraph(fold), [fold]);
  const lit = useMemo(() => {
    if (!selected) return undefined;
    const trail = rows.get(selected)?.trail ?? [];
    return new Set([...trail.map((r) => r.id), ...madeFromIt(fold, selected)]);
  }, [fold, rows, selected]);

  // Each column top to bottom; the last holds the final outputs under their section titles.
  const place = new Map<string, { x: number; y: number }>();
  const heads: { title: string; x: number; y: number }[] = [];
  let height = 0;
  for (let c = 0; c < graph.columns; c++) {
    const x = PAD + c * (COL_W + COL_GAP);
    let y = PAD;
    const inColumn = graph.nodes.filter((n) => n.column === c);
    const sections = [
      ...new Set(inColumn.map((n) => (n.state.final ? n.state.section : undefined))),
    ];
    for (const section of sections) {
      if (section) {
        heads.push({ title: section, x, y });
        y += HEAD_H;
      }
      for (const n of inColumn.filter(
        (m) => (m.state.final ? m.state.section : undefined) === section,
      )) {
        place.set(n.id, { x, y });
        y += ROW_H + ROW_GAP;
      }
      if (section) y += ROW_GAP * 2;
    }
    height = Math.max(height, y);
  }
  const width = PAD * 2 + graph.columns * COL_W + (graph.columns - 1) * COL_GAP;
  const outOfDate = graph.nodes.filter((n) => n.state.outOfDate).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="flex flex-wrap gap-x-3 border-b border-border px-4 py-2 text-sm text-muted-foreground">
        <span>{graph.nodes.length} outputs</span>
        {outOfDate > 0 && <span>{outOfDate} out of date</span>}
        {selected && (
          <span>
            In the spotlight: <span className="text-foreground">{nameOf(selected)}</span>, what it
            rests on and what rests on it
          </span>
        )}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        {graph.nodes.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No outputs yet.</p>
        ) : (
          <div className="relative" style={{ width, height: height + PAD }}>
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0"
              width={width}
              height={height + PAD}
            >
              {graph.links.map((l) => {
                const a = place.get(l.from);
                const b = place.get(l.to);
                if (!a || !b) return null;
                const on = !lit || (lit.has(l.from) && lit.has(l.to));
                const x1 = a.x + COL_W;
                const y1 = a.y + ROW_H / 2;
                const x2 = b.x;
                const y2 = b.y + ROW_H / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <path
                    key={`${l.from}>${l.to}`}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    strokeWidth={on && lit ? 1.5 : 1}
                    strokeDasharray={
                      l.role === "context" ? "4 3" : l.role === "base" ? "1 3" : undefined
                    }
                    className={on && lit ? "stroke-select" : "stroke-border"}
                  />
                );
              })}
            </svg>
            {heads.map((h) => (
              <h3
                key={h.title}
                className="absolute truncate text-xs font-semibold"
                style={{ left: h.x, top: h.y, width: COL_W, lineHeight: `${HEAD_H - 4}px` }}
              >
                {h.title}
              </h3>
            ))}
            {graph.nodes.map((n) => {
              const at = place.get(n.id)!;
              const { status, word } = OUTPUT_STATUS[n.state.status];
              const dim = lit && !lit.has(n.id);
              const value = rows.get(n.id)?.value;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onPick(n.id)}
                  title={`${nameOf(n.id)}: ${word}`}
                  className={cx(
                    "absolute flex cursor-pointer items-center gap-1.5 rounded-sm bg-card px-2 text-left text-xs inset-ring inset-ring-border hover:bg-accent",
                    n.id === selected && "inset-ring-select bg-select-tint",
                    dim && "opacity-40",
                  )}
                  style={{ left: at.x, top: at.y, width: COL_W, height: ROW_H }}
                >
                  <StatusGlyph status={status} />
                  <span className="min-w-0 flex-1 truncate">{nameOf(n.id)}</span>
                  {value && (
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {value.text}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Final outputs: a run of the agent loop's final outputs in their sections, each with its value and
 * status, then the outputs a worker reported that the workflow does not declare. A section opens
 * when it holds the output in view or something to check. "Needs you" keeps only the outputs with
 * an open To check item. Picking an output frames the panes on it and roots the trail on it.
 *
 * Plain on purpose: the side panels are being redesigned; the trail panel holds the detail.
 */
import type { OutputStatus } from "@voluma/contracts/output-fold";
import type { OutputItem, OutputRow, OutputsReview } from "@voluma/run-view";
import { Button, EmptyState, List, Row, type Status, StatusGlyph } from "@voluma/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

/** Each output status on the shared status marks, in the design's words. */
export const OUTPUT_STATUS: Record<OutputStatus, { status: Status; word: string }> = {
  pending: { status: "waiting", word: "Pending" },
  reported: { status: "done", word: "Reported" },
  "to-check": { status: "check", word: "To check" },
  missing: { status: "stopped", word: "Missing" },
  "out-of-date": { status: "paused", word: "Out of date" },
};

export type Accepting = {
  /** Looks right on an item; absent while no decision can be taken (`readOnly` says why). */
  accept?: (item: OutputItem) => void;
  readOnly?: string;
  /** The item being saved. */
  pending?: string;
  error?: { key: string; text: string };
};

const needsYou = (r: OutputRow) => r.items.some((i) => !i.resolved);

export function OutputsPanel({
  review,
  selected,
  onSelect,
  live,
}: {
  review: OutputsReview;
  /** The output the trail is rooted on. */
  selected: OutputRow | undefined;
  onSelect: (id: string) => void;
  live: boolean;
}) {
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const { sections, undeclared } = review;
  if (sections.length === 0 && undeclared.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={live ? "No outputs yet" : "No outputs were recorded"}>
          {live ? "The outputs appear once the AI has set them up." : undefined}
        </EmptyState>
      </div>
    );
  const needing = new Set([...review.rows.values()].filter(needsYou).map((r) => r.id));
  const groups = [
    ...sections,
    ...(undeclared.length > 0 ? [{ title: "Not in the workflow", rows: undeclared }] : []),
  ]
    .map((s) => ({ ...s, rows: onlyNeeds ? s.rows.filter((r) => needing.has(r.id)) : s.rows }))
    .filter((s) => s.rows.length > 0);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 p-3">
      <div className="flex justify-end pb-1">
        <Button
          size="sm"
          variant={onlyNeeds ? "secondary" : "ghost"}
          aria-pressed={onlyNeeds}
          disabled={needing.size === 0 && !onlyNeeds}
          onClick={() => setOnlyNeeds(!onlyNeeds)}
        >
          Needs you {needing.size}
        </Button>
      </div>
      {groups.map((s) => (
        <Section
          key={s.title}
          title={s.title}
          rows={s.rows}
          selected={selected?.id}
          onSelect={onSelect}
          open={onlyNeeds || s.rows.some((r) => r.id === selected?.id || needing.has(r.id))}
        />
      ))}
      {groups.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">Nothing needs you.</p>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  selected,
  onSelect,
  open: opens,
}: {
  title: string;
  rows: OutputRow[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  open: boolean;
}) {
  // Opens by itself when it comes to hold the selection or an item; a click overrides until then.
  const [toggled, setToggled] = useState<{ when: boolean; open: boolean }>();
  const open = toggled && toggled.when === opens ? toggled.open : opens;
  const toCheck = rows.filter(needsYou).length;
  const first = rows.find((r) => r.value);
  return (
    <section aria-label={title} className="grid gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled({ when: opens, open: !open })}
        className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left text-sm hover:bg-accent"
      >
        <ChevronRight
          aria-hidden
          className={
            open ? "size-3.5 rotate-90 transition-transform" : "size-3.5 transition-transform"
          }
        />
        <span className="font-semibold">{title}</span>
        {!open && first?.value && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {first.name} {first.value.text} {first.value.unit}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {toCheck > 0 ? `${toCheck} to check` : `${rows.length}`}
        </span>
      </button>
      {open && (
        <List label={title} columns="auto 16px" density="compact">
          {rows.map((r) => (
            <OutputListRow
              key={r.id}
              row={r}
              selected={r.id === selected}
              onSelect={() => onSelect(r.id)}
            />
          ))}
        </List>
      )}
    </section>
  );
}

function OutputListRow({
  row,
  selected,
  onSelect,
}: {
  row: OutputRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { status, word } = OUTPUT_STATUS[row.state.status];
  return (
    <Row
      title={row.name}
      selected={selected}
      onSelect={onSelect}
      cells={[
        <span key="value" className="font-mono text-xs tabular-nums whitespace-nowrap">
          {row.value ? (
            <>
              {row.value.text}
              {row.value.unit && <span className="text-muted-foreground"> {row.value.unit}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{word}</span>
          )}
        </span>,
        <span key="status" title={word}>
          <StatusGlyph status={status} />
          <span className="sr-only">{word}</span>
        </span>,
      ]}
    />
  );
}

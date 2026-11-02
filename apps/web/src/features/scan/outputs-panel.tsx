/**
 * Outputs: a run of the agent loop's final outputs in their sections, each with its value and
 * status, then the outputs a worker reported that the workflow does not declare; under them, the
 * output in view: its status, value, what it is measured on, and the To check items on it and on
 * what it was made from, each accepted here (Looks right). Picking an output opens it in the
 * scene; Show moves the scene to an item's place.
 */
import type { OutputStatus } from "@voluma/contracts/output-fold";
import { ItemToCheck, type OutputItem, type OutputRow, type OutputsReview } from "@voluma/run-view";
import {
  Button,
  EmptyState,
  List,
  Readout,
  Row,
  type Status,
  StatusGlyph,
  StatusMark,
} from "@voluma/ui";
import { Crosshair } from "lucide-react";

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

export function OutputsPanel({
  review,
  selected,
  onSelect,
  nameOf,
  live,
  item,
  onItem,
  accepting,
}: {
  review: OutputsReview;
  /** The output in view. */
  selected: OutputRow | undefined;
  onSelect: (id: string) => void;
  nameOf: (id: string) => string;
  live: boolean;
  /** The item whose place the scene shows. */
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
}) {
  const { sections, undeclared } = review;
  if (sections.length === 0 && undeclared.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={live ? "No outputs yet" : "No outputs were recorded"}>
          {live ? "The outputs appear once the AI has set them up." : undefined}
        </EmptyState>
      </div>
    );
  const list = (rows: OutputRow[], label: string) => (
    <List label={label} columns="auto 16px" density="compact">
      {rows.map((r) => (
        <OutputListRow
          key={r.id}
          row={r}
          selected={r.id === selected?.id}
          onSelect={() => onSelect(r.id)}
        />
      ))}
    </List>
  );
  return (
    // One track no wider than the panel, as the Report panel's.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 p-4">
      {sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="grid gap-1.5">
          <h3 className="text-sm font-semibold">{s.title}</h3>
          {list(s.rows, s.title)}
        </section>
      ))}
      {undeclared.length > 0 && (
        <section aria-label="Not in the workflow" className="grid gap-1.5">
          <h3 className="text-sm font-semibold">Not in the workflow</h3>
          {list(undeclared, "Not in the workflow")}
        </section>
      )}
      {selected && (
        <OutputDetail
          row={selected}
          nameOf={nameOf}
          item={item}
          onItem={onItem}
          accepting={accepting}
        />
      )}
    </div>
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

function OutputDetail({
  row,
  nameOf,
  item,
  onItem,
  accepting,
}: {
  row: OutputRow;
  nameOf: (id: string) => string;
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
}) {
  const { state } = row;
  const { status, word } = OUTPUT_STATUS[state.status];
  const names = (ids: string[]) => ids.map(nameOf).join(", ");
  const open = row.items.filter((i) => !i.resolved).length;
  return (
    <article aria-label={row.name} className="grid gap-4 border-t border-border pt-4">
      <header className="grid gap-1.5">
        <h3 className="min-w-0 text-base font-semibold">{row.name}</h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <StatusMark status={status} label={word} />
          {!state.declared && <span>Not in the workflow</span>}
          {row.provisional && <span>Provisional: no reference comparison yet</span>}
        </p>
        {state.missingReason && <p className="text-sm">{state.missingReason}</p>}
        {state.outOfDate && (
          <p className="text-sm">
            Something it was made from has changed since. The AI keeps it or redoes it.
          </p>
        )}
        {row.description && <p className="text-sm leading-relaxed">{row.description}</p>}
      </header>

      {row.value && (
        <Readout values={[{ label: row.name, value: row.value.text, unit: row.value.unit }]} />
      )}
      {(row.on.length > 0 || row.context.length > 0) && (
        <p className="text-sm text-muted-foreground">
          {row.on.length > 0 && `Measured on ${names(row.on)}.`}
          {row.on.length > 0 && row.context.length > 0 && " "}
          {row.context.length > 0 && `Shown with ${names(row.context)}.`}
        </p>
      )}

      {row.items.length > 0 && (
        <section aria-label="To check" className="grid gap-2">
          <h4 className="text-xs text-muted-foreground">
            {open > 0 ? `${open} to check` : "To check"}
          </h4>
          {row.items.map((i) => (
            <ItemToCheck
              key={i.key}
              context={i.output === row.id ? row.name : nameOf(i.output)}
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
        </section>
      )}
    </article>
  );
}

/**
 * One version of an output, as Final outputs shows it: the line naming it (version, who made it,
 * when), its report (the worker's own words, the images it was checked on, what it was made
 * from), and To check items with Accept and Show. The data comes from the output fold and
 * `versionWords` (`@voluma/run-view`).
 */
import { outputFileUrl } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import type { OutputVersion } from "@voluma/contracts/output-fold";
import { ItemToCheck, Markdown, type OutputItem, ROLE_WORD, versionWords } from "@voluma/run-view";
import { Button } from "@voluma/ui";
import { Crosshair } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

export const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export type Accepting = {
  /** Accept on an item; absent while no decision can be taken (`readOnly` says why). */
  accept?: (item: OutputItem) => void;
  readOnly?: string;
  /** The item being saved. */
  pending?: string;
  error?: { key: string; text: string };
};

/** `v1 roi3-worker 19:05`, then what follows it on the line (a Report toggle). */
export function VersionLine({ v, children }: { v: OutputVersion; children?: ReactNode }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-xs">
      <span className="rounded-sm bg-muted px-1 font-mono">v{v.version}</span>
      <span className="font-mono text-foreground">{v.by}</span>
      <span>{clockOf(v.at)}</span>
      {children}
    </p>
  );
}

/** The items of a version (or a value's, with those of what it rests on), each with its decision. */
export function Items({
  items,
  own,
  nameOf,
  item,
  onItem,
  accepting,
}: {
  items: OutputItem[];
  /** The output these items are shown under: its own need no "which this rests on". */
  own: string;
  nameOf: (id: string) => string;
  /** The item whose place the panes show. */
  item: string | undefined;
  onItem: (item: OutputItem) => void;
  accepting: Accepting;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {items.map((i) => (
        <ItemToCheck
          key={i.key}
          context={i.output === own ? nameOf(own) : `On ${nameOf(i.output)}, which this rests on`}
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
    </div>
  );
}

/** The items a version raised, as `OutputItem`s. */
export function itemsOfVersion(id: string, v: OutputVersion): OutputItem[] {
  return v.toCheck.map((t, i) => ({
    key: `${id}/${v.version}/${i}`,
    output: id,
    version: v.version,
    item: i,
    title: t.title,
    ...(t.focus && { focus: t.focus }),
    resolved: t.resolved !== undefined,
  }));
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** A version's report: why it was kept, the worker's own words, its evidence, what it was made from. */
export function Report({
  runId,
  events,
  v,
  outOfDate,
  nameOf,
  madeFrom = true,
}: {
  runId: string;
  events: readonly RunEvent[];
  v: OutputVersion;
  outOfDate: boolean;
  nameOf: (id: string) => string;
  /** Off where "Rests on" already lists it. */
  madeFrom?: boolean;
}) {
  const words = useMemo(() => versionWords(events, v), [events, v]);
  const head = "m-0 pt-1 font-medium text-muted-foreground text-xs";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
      {v.kept && <p className="m-0 text-muted-foreground text-xs">Kept: {v.kept.reason}</p>}
      {outOfDate && (
        <p className="m-0">
          Something it was made from has changed since. The AI keeps it or redoes it.
        </p>
      )}
      {words && <Markdown text={words} className="text-sm" />}
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
      {madeFrom && v.madeFrom.length > 0 && (
        <>
          <h5 className={head}>Made from</h5>
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {v.madeFrom.map((l) => (
              <li key={`${l.id}/${l.version}`} className="flex gap-2 text-sm">
                <span className="w-20 shrink-0 text-muted-foreground text-xs">
                  {ROLE_WORD[l.role]}
                </span>
                <span className="min-w-0 truncate">{nameOf(l.id)}</span>
                <span className="font-mono text-muted-foreground text-xs">v{l.version}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

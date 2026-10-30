/**
 * To check: this scan's items, one open at a time. The open item's card (`ItemToCheck`) holds the
 * decision; Next names the item after it; the list below is every item of the scan, open first in
 * task order, handled after. Picking an item sets up the views on its task and place.
 */
import { reviewFileUrl } from "@voluma/api-client";
import { ItemToCheck, type NeedItem, type TaskView } from "@voluma/run-view";
import { Disclosure, EmptyState, IconButton, Lightbox, List, Row, StatusGlyph } from "@voluma/ui";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useState } from "react";
import type { Accepting } from "./scan-page";

export function ToCheckPanel({
  runId,
  scan,
  items,
  tasks,
  current,
  onPick,
  accepting,
  onWrong,
  live,
}: {
  runId: string;
  scan: string;
  /** Every item of the scan in task order, with what was accepted here. */
  items: NeedItem[];
  tasks: TaskView[];
  current: NeedItem | undefined;
  onPick: (item: NeedItem) => void;
  accepting: Accepting;
  onWrong: (item: NeedItem) => void;
  live: boolean;
}) {
  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? taskId;
  if (!current)
    return (
      <div className="p-4">
        <EmptyState title={live ? "Nothing to check yet" : "Nothing to check on this scan"}>
          {live
            ? "Items appear here when the AI asks for your check."
            : "The AI and its second check raised no item here."}
        </EmptyState>
      </div>
    );
  const open = items.filter((n) => !n.accepted);
  const handled = items.length - open.length;
  // The order you work in: open items first, then those already handled.
  const queue = [...open, ...items.filter((n) => n.accepted)];
  const at = queue.indexOf(current);
  const next = queue.slice(at + 1).find((n) => !n.accepted);
  const task = tasks.find((t) => t.id === current.taskId);
  return (
    <div className="grid gap-3 p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 font-mono text-xs text-muted-foreground">
          {at + 1} of {queue.length} on {scan}
        </p>
        <IconButton
          size="sm"
          label="Previous item"
          disabled={at <= 0}
          onClick={() => onPick(queue[at - 1] as NeedItem)}
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          size="sm"
          label="Next item"
          disabled={at >= queue.length - 1}
          onClick={() => onPick(queue[at + 1] as NeedItem)}
        >
          <ChevronRight />
        </IconButton>
      </div>
      <ItemToCheck
        key={current.id}
        className="inset-ring-select"
        task={titleOf(current.taskId)}
        title={current.title}
        text={current.text}
        found={
          current.found ? (
            <Disclosure label="What the second AI check found">
              <p className="whitespace-pre-wrap">{current.found}</p>
            </Disclosure>
          ) : task?.check?.summary ? (
            `Second AI check: ${task.check.summary}`
          ) : undefined
        }
        evidence={
          current.image && (
            <Evidence runId={runId} name={current.image.name} sha256={current.image.sha256} />
          )
        }
        state={current.accepted ? "accepted" : current.acceptable ? "open" : "info"}
        onAccept={accepting.accept && (() => accepting.accept?.(current))}
        accepting={accepting.pending === current.id}
        readOnly={accepting.readOnly}
        onWrong={() => onWrong(current)}
        error={accepting.error?.id === current.id ? accepting.error.text : undefined}
      />
      {next && (
        <button
          type="button"
          onClick={() => onPick(next)}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2.5 text-left inset-ring inset-ring-border hover:bg-accent"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">Next on {scan}</span>
            <span className="block truncate text-sm font-medium">
              {next.title ?? titleOf(next.taskId)}
            </span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </button>
      )}
      <section aria-label={`This scan's ${items.length} items`}>
        <h3 className="flex items-baseline gap-2 px-1 pt-1 pb-1.5 text-sm font-semibold">
          This scan's {items.length} {items.length === 1 ? "item" : "items"}
          <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">
            {handled} handled
          </span>
        </h3>
        <List boxed density="compact" columns="minmax(0,9rem)">
          {queue.map((n) => (
            <Row
              key={n.id}
              selected={n.id === current.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <StatusGlyph status={n.accepted ? "done" : "check"} />
                  <span className="truncate">{n.title ?? titleOf(n.taskId)}</span>
                </span>
              }
              cells={[
                <span
                  key="task"
                  className="block truncate text-right text-xs text-muted-foreground"
                >
                  {titleOf(n.taskId)}
                </span>,
              ]}
              onSelect={() => onPick(n)}
            />
          ))}
        </List>
      </section>
    </div>
  );
}

/** A QC image: a thumbnail that opens full size. */
export function Evidence({ runId, name, sha256 }: { runId: string; name: string; sha256: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = reviewFileUrl(runId, sha256);
  const file = name.split("/").at(-1) ?? name;
  if (failed)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" aria-hidden />
        {file} couldn't be loaded.
      </p>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${file} full size`}
        className="block cursor-zoom-in overflow-hidden rounded-md bg-muted inset-ring inset-ring-border"
      >
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-40 w-full object-contain"
        />
      </button>
      <Lightbox open={open} onClose={() => setOpen(false)} caption={file}>
        <img src={url} alt={file} />
      </Lightbox>
    </>
  );
}

/**
 * To check: this scan's items, one open at a time. The open item's card (`ItemToCheck`) holds the
 * decision; Next names the next open item; the list below is the scan's open items in task
 * order. "Looks right" moves on to the next open item of the same task, else of the scan, and the
 * handled item leaves the list. Picking an item sets up the views on its task and place.
 */
import { reviewFileUrl } from "@voluma/api-client";
import { ItemToCheck, type NeedItem, type TaskView } from "@voluma/run-view";
import { Disclosure, EmptyState, IconButton, Lightbox, List, Row, StatusGlyph } from "@voluma/ui";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import type { Accepting } from "./scan-page";

export function ToCheckPanel({
  runId,
  items,
  tasks,
  current,
  inView,
  onPick,
  accepting,
  wrongReason,
  onWrong,
  live,
}: {
  runId: string;
  /** Every item of the scan in task order, reconciled with authoritative human decisions. */
  items: NeedItem[];
  tasks: TaskView[];
  /** The open item: one of the task in view's, none when that task has none. */
  current: NeedItem | undefined;
  /** The task in view's title. */
  inView: string | undefined;
  onPick: (item: NeedItem) => void;
  accepting: Accepting;
  /** Why Something's wrong is off (the run read's `cannotMessage`). */
  wrongReason: string | undefined;
  onWrong: (item: NeedItem) => void;
  live: boolean;
}) {
  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? taskId;
  // The item in view when a save lands: the move after Looks right happens only if it is still
  // the one accepted, so a pick made while saving wins.
  const shown = useRef(current?.id);
  shown.current = current?.id;
  // The item the panel moved to after Looks right, whose Looks right takes focus.
  const [arrived, setArrived] = useState<string>();
  if (items.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={live ? "Nothing to check yet" : "No items to check were recorded"}>
          {live
            ? "Items appear here when the AI asks for your check."
            : "See Report for which tasks finished and what they reported."}
        </EmptyState>
      </div>
    );
  const open = items.filter((n) => !n.accepted);
  const handled = items.length - open.length;
  // The open items in task order; the item in view stays in its place once handled, so a
  // handled item picked from Report still reads as one of them.
  const queue = items.filter((n) => !n.accepted || n === current);
  const at = current ? queue.indexOf(current) : -1;
  const waiting = (n: NeedItem) => !n.accepted && n !== current;
  // Next, as the arrows go: none after the last.
  const next = queue.slice(at + 1).find(waiting);
  // Where "Looks right" moves: the same task's next open item, else the scan's, round to the
  // first still open.
  const after = [...queue.slice(at + 1), ...queue.slice(0, Math.max(at, 0))].filter(waiting);
  const then = after.find((n) => n.taskId === current?.taskId) ?? after[0];
  const task = current && tasks.find((t) => t.id === current.taskId);
  return (
    // One column no wider than the panel: an auto column would grow to the longest truncated title.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          {current
            ? `${at + 1} of ${queue.length}`
            : `Nothing to check in ${inView ?? "this task"}`}
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
      {current && (
        <ItemToCheck
          key={current.id}
          className="inset-ring-select"
          context={titleOf(current.taskId)}
          title={current.title}
          text={current.text}
          found={
            current.found ? (
              <Disclosure label="What the second AI check found">
                <p className="whitespace-pre-wrap">{current.found}</p>
              </Disclosure>
            ) : task?.check?.summary && task.check.id !== current.id ? (
              // An item that is the check's own verdict already reads its sentence.
              `Second AI check: ${task.check.summary}`
            ) : undefined
          }
          evidence={
            current.image && (
              <Evidence runId={runId} name={current.image.name} sha256={current.image.sha256} />
            )
          }
          state={current.accepted ? "accepted" : current.acceptable ? "open" : "info"}
          onAccept={
            accepting.accept &&
            (() => {
              // Hold this item in view until it is saved; then move on, when anything is left.
              onPick(current);
              accepting.accept?.(
                current,
                then &&
                  (() => {
                    if (shown.current !== current.id) return;
                    setArrived(then.id);
                    onPick(then);
                  }),
              );
            })
          }
          accepting={accepting.pending === current.id}
          focusAccept={current.id === arrived}
          readOnly={accepting.readOnly}
          onWrong={() => onWrong(current)}
          wrongReason={wrongReason}
          error={accepting.error?.id === current.id ? accepting.error.text : undefined}
        />
      )}
      {next && (
        <button
          type="button"
          onClick={() => onPick(next)}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2.5 text-left inset-ring inset-ring-border hover:bg-accent"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">Next</span>
            <span className="block truncate text-sm font-medium">
              {next.title ?? titleOf(next.taskId)}
            </span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </button>
      )}
      <section aria-labelledby="scan-open-items">
        <h3
          id="scan-open-items"
          className="flex items-baseline gap-2 px-1 pt-1 pb-1.5 text-sm font-semibold"
        >
          {open.length > 0 ? `${open.length} left to check` : "Nothing left to check"}
          {handled > 0 && (
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {handled} handled
            </span>
          )}
        </h3>
        <List boxed density="compact" columns="minmax(0,7.5rem)">
          {queue.map((n) => (
            <Row
              key={n.id}
              selected={n.id === current?.id}
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
        className="block min-h-16 min-w-16 w-fit max-w-full cursor-zoom-in overflow-hidden rounded-md inset-ring inset-ring-border"
      >
        {/* The frame is the image's own size: no empty card around a narrow or short image. */}
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="block max-h-40 w-auto max-w-full"
        />
      </button>
      <Lightbox open={open} onClose={() => setOpen(false)} caption={file}>
        <img src={url} alt={file} />
      </Lightbox>
    </>
  );
}

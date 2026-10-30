/**
 * The queue panel: a modal <dialog> over the page (Esc and Close return to it), one item at a
 * time. The header steps through the queue (‹ ›, "N of M", how many were signed off here),
 * links the whole run's review, and maximizes. "Looks right" accepts the item's check and moves
 * on. The viewer remounts per item, so an item on another run loads that scan afresh.
 */
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { acceptCheck, getMe, getReviewRun, getRun } from "@voluma/api-client";
import { Button } from "@voluma/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ItemView } from "./item-view";
import type { CheckItem, CheckPanelProps } from "./types";

// The panel's own cache: pages hear of changes through `onAccepted`.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
/** How long "Looked right" shows before the next item opens. */
const ADVANCE_MS = 600;

/** `fn` once `ms` after the last call; the stream replays a long log in a burst. */
function useDebounced(fn: () => void, ms: number) {
  const latest = useRef(fn);
  latest.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [call] = useState(() => () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), ms);
  });
  return call;
}

const keyOf = (item: CheckItem) => `${item.runId}/${item.taskId}/${item.checkId ?? ""}`;

export function CheckPanel(props: CheckPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <Panel {...props} />
    </QueryClientProvider>
  );
}

function Panel({ items, start, onClose, onAccepted }: CheckPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), items.length - 1));
  const [maximized, setMaximized] = useState(false);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const item = items[index]!;
  const client = useQueryClient();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const review = useQuery({
    queryKey: ["review-run", item.runId],
    queryFn: () => getReviewRun(item.runId),
  });
  // Whether the run is an example (read-only), and who may talk to its AI.
  const run = useQuery({
    queryKey: ["run", item.runId],
    queryFn: () => getRun(item.runId),
    // A reopened run's claim ends without the panel's stream open: poll until it has.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: Number.POSITIVE_INFINITY });
  // The run's stream moved: its state, and maybe its results, did too.
  const runChanged = useDebounced(() => {
    void client.invalidateQueries({ queryKey: ["run", item.runId] });
    void client.invalidateQueries({ queryKey: ["review-run", item.runId] });
  }, 1500);

  const accept = useMutation({
    mutationFn: ({ item, revisionId }: { item: CheckItem; revisionId: string }) =>
      acceptCheck(item.runId, item.checkId!, { baseRevisionId: revisionId, taskId: item.taskId }),
    onSuccess: (next, { item: accepted }) => {
      client.setQueryData(["review-run", accepted.runId], next);
      setDone((all) => new Set(all).add(keyOf(accepted)));
      onAccepted?.(accepted);
      setTimeout(() => {
        setIndex((i) => (keyOf(items[i]!) === keyOf(accepted) && i < items.length - 1 ? i + 1 : i));
      }, ADVANCE_MS);
    },
  });

  const go = (to: number) => {
    accept.reset();
    setIndex(to);
  };
  const task = review.data?.revisions.at(-1)?.tasks.find((t) => t.id === item.taskId);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal <dialog>; the click is the pointer-only backdrop dismissal.
    <dialog
      ref={dialog}
      aria-label="Check in 3D"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-0 text-foreground backdrop:bg-backdrop"
    >
      <section
        className={
          maximized
            ? "absolute inset-0 flex flex-col overflow-hidden bg-card"
            : "absolute inset-0 flex flex-col overflow-hidden bg-card md:inset-y-3 md:right-3 md:left-auto md:w-[min(1180px,calc(100vw-80px))] md:rounded-xl md:shadow-xl"
        }
      >
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-2 pr-3 pl-4">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h2 className="truncate text-[15px] font-semibold">
              {task?.title ?? (review.isPending ? "Loading…" : item.taskId)}
            </h2>
            {review.data && (
              <span className="truncate font-mono text-meta text-muted-foreground">
                {review.data.sample}
              </span>
            )}
          </div>
          <nav aria-label="Queue" className="flex items-center gap-2 text-ui">
            <Button
              size="sm"
              aria-label="Previous"
              disabled={index === 0}
              onClick={() => go(index - 1)}
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="tabular-nums" aria-live="polite">
              {index + 1} of {items.length}
              {done.size > 0 && (
                <span className="ml-2 text-muted-foreground">{done.size} done</span>
              )}
            </span>
            <Button
              size="sm"
              aria-label="Next"
              disabled={index === items.length - 1}
              onClick={() => go(index + 1)}
            >
              <ChevronRight size={16} />
            </Button>
          </nav>
          <span className="flex-1" />
          <div className="flex items-center gap-2">
            <Link
              to={`/runs/${encodeURIComponent(item.runId)}?task=${encodeURIComponent(item.taskId)}`}
              className="px-1 text-ui font-medium text-primary-text hover:underline"
            >
              Whole run in 3D
            </Link>
            {/* A phone shows the panel full screen already. */}
            <span className="hidden md:contents">
              <Button size="sm" onClick={() => setMaximized((m) => !m)}>
                {maximized ? "Restore" : "Maximize"}
              </Button>
            </span>
            <Button size="sm" onClick={() => dialog.current?.close()}>
              Close
            </Button>
          </div>
        </header>
        <ItemView
          key={keyOf(item)}
          item={item}
          review={review}
          runInfo={run.data}
          me={me.data}
          onRunChanged={runChanged}
          canAccept={run.data?.example === false && review.data?.review != null}
          example={run.data?.example === true}
          accepted={done.has(keyOf(item))}
          accept={accept}
        />
      </section>
    </dialog>
  );
}

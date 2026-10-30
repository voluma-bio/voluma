/**
 * The run's Overview, and the parts the task view shares with it: what the AI is working on now,
 * the To check items as cards (the QC image, what's wrong, "Looks right", "Open in 3D"), and the
 * values grouped by task. Data: `TaskView`s from `runView`; accepting goes through `acceptCheck`.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, acceptCheck, reviewFileUrl } from "@voluma/api-client";
import type { Asset } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import { Button, Count, cx, EmptyState, Lightbox } from "@voluma/ui";
import { ChevronRight, ImageOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { Elapsed } from "./agents";
import { ClampedMarkdown } from "./chat/markdown";
import type { NeedItem, TaskView } from "./run-model";
import { TaskMark } from "./task-flow";

/** "Looks right" on a completed run: accepts one check of the latest result. */
export type Accepting = {
  /** Only a completed run's latest result takes decisions, and an example takes none. */
  enabled: boolean;
  accept: (item: NeedItem) => void;
  /** Accepted here, before the stream brings the decision back. */
  done: ReadonlySet<string>;
  /** Sent and not answered yet. */
  pending: ReadonlySet<string>;
  /** The latest failure, by item. */
  error?: { id: string; text: string };
};

const without = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function useAccepting(
  run: Run,
  onChange: (update: (run: Run) => Run) => void,
  refetch: () => void,
): Accepting {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<Accepting["error"]>();
  const mutation = useMutation({
    mutationFn: (item: NeedItem) => {
      if (!run.review) throw new Error("no completed result");
      return acceptCheck(run.id, item.id, {
        baseRevisionId: run.review.revisionId,
        taskId: item.taskId,
      });
    },
    onMutate: (item) => {
      setPending((p) => new Set(p).add(item.id));
      setError((e) => (e?.id === item.id ? undefined : e));
    },
    onSuccess: (res, item) => {
      setDone((d) => new Set(d).add(item.id));
      onChange((r) => ({ ...r, review: res.review }));
    },
    onError: (e, item) => {
      const status = e instanceof ApiError ? e.status : undefined;
      if (status === 409) refetch();
      setError({
        id: item.id,
        text:
          status === 403
            ? "This example is read-only."
            : status === 409
              ? "The result changed since this page loaded. Reload to see it."
              : "Couldn't save that. Try again.",
      });
    },
    onSettled: (_res, _e, item) => setPending((p) => without(p, item.id)),
  });
  return {
    enabled: run.review !== null && !run.example,
    accept: (item) => mutation.mutate(item),
    done,
    pending,
    error,
  };
}

/** Where "Open in 3D" goes until the review panel exists: the review, at the task. */
export const reviewHref = (runId: string, taskId?: string) =>
  `/runs/${runId}${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`;

export function Overview({
  runId,
  tasks,
  toCheck,
  ended,
  example,
  accepting,
  search,
}: {
  runId: string;
  tasks: TaskView[];
  /** The header's number: open items "Looks right" can accept; 0 on an ended run that takes no decisions. */
  toCheck: number;
  ended: boolean;
  example: boolean;
  accepting: Accepting;
  search: (taskId?: string) => string;
}) {
  const now = tasks.filter((t) => NOW.has(t.state));
  const working = now.some((t) => t.state === "running" || t.state === "checking");
  const paused = now.every((t) => t.state === "paused");
  const awaitingAI = now.every((t) => t.state === "awaiting-ai");
  const failed = tasks.filter((t) => t.state === "failed");
  const needs = tasks.flatMap((t) => t.needs);
  const open = needs.filter((n) => !n.accepted && !accepting.done.has(n.id));
  const looked = needs.filter((n) => n.accepted || accepting.done.has(n.id));
  const valued = tasks.filter((t) => t.valued);
  const title = new Map(tasks.map((t) => [t.id, t.title]));
  return (
    <>
      {now.length > 0 && (
        <Section
          title={
            awaitingAI
              ? "Waiting for the AI"
              : paused
                ? "Paused"
                : working
                  ? "Working on now"
                  : "In progress"
          }
        >
          <ul className="flex flex-wrap gap-2.5">
            {now.map((t) => (
              <li key={t.id}>
                <Link
                  to={search(t.id)}
                  className={cx(
                    "flex min-w-60 items-start gap-3 rounded-xl px-3.5 py-2.5 text-ui hover:ring-1",
                    t.state === "running" || t.state === "checking"
                      ? "bg-info-tint hover:ring-info"
                      : "bg-muted hover:ring-line-strong",
                  )}
                >
                  <TaskMark state={t.state} className="mt-1" />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{t.title}</span>
                    <span className="block text-muted-foreground">{doingNow(t)}</span>
                    {(t.state === "running" || t.state === "checking") && t.latest && (
                      <Elapsed thread={t.latest} />
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Needs your eye" count={toCheck}>
        {open.length + failed.length === 0 ? (
          <EmptyState
            title={
              looked.length > 0
                ? "You've looked at everything"
                : ended
                  ? "Nothing to check"
                  : "Nothing yet"
            }
          >
            {looked.length === 0 && !ended
              ? "Items appear as the AI finishes each task."
              : undefined}
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-2.5">
            {ended && !accepting.enabled && open.length > 0 && (
              <p className="col-span-full text-ui text-muted-foreground">
                {example
                  ? "This example is read-only."
                  : "This run didn't finish, so nothing here can be marked as looked at."}
              </p>
            )}
            {failed.map((t) => (
              <FailedCard key={t.id} task={t} to={search(t.id)} />
            ))}
            {open.map((n) => (
              <NeedCard
                key={n.id}
                runId={runId}
                item={n}
                task={{ title: title.get(n.taskId) ?? n.taskId, to: search(n.taskId) }}
                accepting={accepting}
              />
            ))}
          </div>
        )}
        <LookedRight items={looked} title={title} />
      </Section>

      {valued.length > 0 && (
        <Section title="Results">
          <ResultsTable tasks={valued} search={search} />
        </Section>
      )}
    </>
  );
}

/** The tasks the first section lists: under way, or stopped partway until something resumes them. */
const NOW: ReadonlySet<TaskView["state"]> = new Set([
  "running",
  "checking",
  "held",
  "paused",
  "awaiting-ai",
]);

/** A started task's line: what the AI is doing on it, in the researcher's words. */
export function doingNow(t: TaskView): string {
  switch (t.state) {
    case "checking":
      return "A second AI is checking the result";
    case "paused":
      return t.did ?? t.purpose ?? "Paused";
    case "awaiting-ai":
      return t.did ?? t.purpose ?? "Waiting for the AI";
    case "held":
      return "Waiting on the lead AI";
    default:
      return (
        t.did ?? (t.redone ? "Redoing it after the second AI check" : (t.purpose ?? "Working"))
      );
  }
}

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold [text-wrap:balance]">
        {title}
        {count ? <Count tone="check">{count}</Count> : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * A run's QC image: fetched only when near the screen (each is 80-360 KB and there is no
 * smaller rendition), opened full size on click. A copied or pruned run can lack the file.
 */
export function QcImage({
  runId,
  asset,
  className,
  imageClassName = "size-full object-cover",
}: {
  runId: string;
  asset: Asset;
  className?: string;
  imageClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = reviewFileUrl(runId, asset.sha256);
  if (broken)
    return (
      <span
        className={cx(
          "grid place-items-center gap-1 rounded-lg bg-muted p-2 text-center text-meta text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="size-4" aria-hidden />
        Image not available
      </span>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx("cursor-zoom-in overflow-hidden rounded-lg bg-viewer-well", className)}
      >
        <img
          src={src}
          alt={`QC evidence ${asset.name}`}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className={imageClassName}
        />
      </button>
      <Lightbox open={open} onClose={() => setOpen(false)} caption={asset.name}>
        {open && <img src={src} alt={`QC evidence ${asset.name}`} />}
      </Lightbox>
    </>
  );
}

export function NeedCard({
  runId,
  item,
  task,
  accepting,
}: {
  runId: string;
  item: NeedItem;
  /** In the Overview: the task it belongs to, which links to the task. */
  task?: { title: string; to: string };
  accepting: Accepting;
}) {
  const error = accepting.error?.id === item.id ? accepting.error.text : undefined;
  return (
    <article className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 rounded-xl border border-check-line bg-check-tint p-2.5">
      {item.image ? (
        <QcImage runId={runId} asset={item.image} className="size-22" />
      ) : (
        <span className="size-22 rounded-lg bg-muted" aria-hidden />
      )}
      <div className="min-w-0">
        {task ? (
          <Link to={task.to} className="text-ui font-semibold text-foreground hover:underline">
            {task.title}
          </Link>
        ) : null}
        {item.title && <p className="text-ui font-medium text-check-strong">{item.title}</p>}
        <p
          title={item.text}
          className="mt-1 mb-2.5 line-clamp-4 text-ui text-foreground [overflow-wrap:anywhere]"
        >
          {plain(item.text)}
        </p>
        {item.found && <WhatItFound text={item.found} className="mb-2.5" />}
        <div className="flex flex-wrap gap-2">
          {accepting.enabled && item.acceptable && (
            <Button
              size="sm"
              disabled={accepting.pending.has(item.id)}
              onClick={() => accepting.accept(item)}
            >
              {accepting.pending.has(item.id) ? "Saving…" : "Looks right"}
            </Button>
          )}
          <Button asChild size="sm">
            <Link to={reviewHref(runId, item.taskId)}>Open in 3D</Link>
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-meta text-destructive">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}

/**
 * The second AI check's own words, folded: they name files and tools, which the researcher
 * reads only when they ask.
 */
export function WhatItFound({ text, className }: { text: string; className?: string }) {
  return (
    <details className={cx("group text-ui", className)}>
      <Button asChild variant="link">
        <summary className="[&::-webkit-details-marker]:hidden">
          <ChevronRight className="transition-transform group-open:rotate-90" aria-hidden />
          What it found
        </summary>
      </Button>
      <ClampedMarkdown text={text} className="mt-1.5 text-muted-foreground" />
    </details>
  );
}

/** Checkpoint text as one paragraph: its Markdown emphasis dropped, its lines joined. */
const plain = (text: string) =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();

function FailedCard({ task, to }: { task: TaskView; to: string }) {
  return (
    <article className="rounded-xl border border-border bg-destructive-tint p-3 text-ui">
      <Link to={to} className="font-semibold text-foreground hover:underline">
        {task.title}
      </Link>
      <p className="mt-1 text-destructive">
        The AI couldn't finish this task{task.reason ? `: ${plain(task.reason)}` : "."}
      </p>
    </article>
  );
}

export function LookedRight({
  items,
  title,
}: {
  items: NeedItem[];
  /** Task titles, to name each item's task; absent inside one task. */
  title?: Map<string, string>;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-1">
      {items.map((n) => (
        <li key={n.id} className="flex min-w-0 gap-2.5 py-1 text-ui text-muted-foreground">
          <span className="shrink-0 font-medium text-primary-text">Looked right</span>
          <span className="min-w-0 truncate">
            {title ? `${title.get(n.taskId) ?? n.taskId}: ` : ""}
            {n.title ?? plain(n.text)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const NOT_YET: Partial<Record<TaskView["state"], string>> = {
  waiting: "not started",
  ready: "not started",
  running: "in progress",
  checking: "being checked",
  held: "in progress",
  paused: "paused",
  "awaiting-ai": "waiting for the AI",
  stopped: "stopped before it finished",
  skipped: "skipped",
  failed: "failed",
};

/** Values by task; a task without values yet says why. Corrected values are blue. */
export function ResultsTable({
  tasks,
  search,
  single = false,
}: {
  tasks: TaskView[];
  search: (taskId?: string) => string;
  /** One task's own table: no group rows. */
  single?: boolean;
}) {
  return (
    <table className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card text-ui">
      <thead>
        <tr className="border-b border-border bg-muted/40 text-left text-meta text-muted-foreground">
          <th className="px-3.5 py-2 font-medium">Measurement</th>
          <th className="px-3.5 py-2 text-right font-medium">Value</th>
        </tr>
      </thead>
      {tasks.map((t) => {
        const pending = t.results.length === 0 ? NOT_YET[t.state] : undefined;
        return (
          <tbody key={t.id} className="border-b border-border last:border-b-0">
            {!single && (
              <tr className="bg-background">
                <td colSpan={2} className="px-3.5 pt-2.5 pb-1.5 font-semibold">
                  <Link to={search(t.id)} className="hover:underline">
                    {t.title}
                  </Link>
                  {pending && (
                    <span className="ml-2 font-normal text-muted-foreground">{pending}</span>
                  )}
                </td>
              </tr>
            )}
            {single && pending && (
              <tr>
                <td colSpan={2} className="px-3.5 py-2 text-muted-foreground">
                  No values yet: {pending}.
                </td>
              </tr>
            )}
            {t.results.map((r) => (
              <tr key={r.id} className="border-t border-line-subtle first:border-t-0">
                <td className="px-3.5 py-2 align-top">
                  {r.title}
                  {r.note && (
                    <span className="block text-meta text-muted-foreground">{r.note}</span>
                  )}
                </td>
                <td className="px-3.5 py-2 text-right align-top whitespace-nowrap">
                  {r.value === null ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <span
                      className={cx("font-mono tabular-nums", t.corrected && "text-info")}
                      title={t.corrected ? "Changed by a correction" : undefined}
                    >
                      {r.value}
                    </span>
                  )}
                  {r.unit && r.value !== null && (
                    <span
                      className={cx("text-meta text-muted-foreground", r.unit !== "%" && "ml-1")}
                    >
                      {r.unit}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}

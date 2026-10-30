/**
 * The run's Overview, and the parts the task view shares with it: what the AI is working on now,
 * the To check items as cards (the QC image, what's wrong, "Looks right", "Open in 3D"), and the
 * values grouped by task. Data: `TaskView`s from `runView`; accepting goes through `acceptCheck`.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, acceptCheck, reviewFileUrl } from "@voluma/api-client";
import type { Asset } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import { Button, buttonClass, cx, Lightbox } from "@voluma/ui";
import { ImageOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { Elapsed } from "./agents";
import type { NeedItem, TaskView } from "./run-model";
import { TaskMark } from "./task-flow";

/** "Looks right" on a completed run: accepts one check of the latest result. */
export type Accepting = {
  /** Only a completed run's latest result takes decisions. */
  enabled: boolean;
  accept: (item: NeedItem) => void;
  /** Accepted here, before the stream brings the decision back. */
  done: ReadonlySet<string>;
  pending?: string;
  error?: { id: string; text: string };
};

export function useAccepting(
  run: Run,
  onChange: (run: Run) => void,
  refetch: () => void,
): Accepting {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const mutation = useMutation({
    mutationFn: (item: NeedItem) => {
      if (!run.review) throw new Error("no completed result");
      return acceptCheck(run.id, item.id, {
        baseRevisionId: run.review.revisionId,
        taskId: item.taskId,
      });
    },
    onSuccess: (res, item) => {
      setDone((d) => new Set(d).add(item.id));
      onChange({ ...run, review: res.review });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) refetch();
    },
  });
  const failed = mutation.isError ? mutation.variables : undefined;
  const status = mutation.error instanceof ApiError ? mutation.error.status : undefined;
  return {
    enabled: run.review !== null,
    accept: (item) => mutation.mutate(item),
    done,
    pending: mutation.isPending ? mutation.variables?.id : undefined,
    error: failed && {
      id: failed.id,
      text:
        status === 403
          ? "This example is read-only."
          : status === 409
            ? "The result changed since this page loaded. Reload to see it."
            : "Couldn't save that. Try again.",
    },
  };
}

/** Where "Open in 3D" goes until the review panel exists: the review, at the task. */
export const reviewHref = (runId: string, taskId?: string) =>
  `/runs/${runId}${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`;

export function Overview({
  runId,
  tasks,
  ended,
  accepting,
  search,
}: {
  runId: string;
  tasks: TaskView[];
  ended: boolean;
  accepting: Accepting;
  search: (taskId?: string, view?: "decisions") => string;
}) {
  const now = tasks.filter(
    (t) => t.state === "running" || t.state === "checking" || t.state === "paused",
  );
  const failed = tasks.filter((t) => t.state === "failed");
  const needs = tasks.flatMap((t) => t.needs);
  const open = needs.filter((n) => !n.accepted && !accepting.done.has(n.id));
  const looked = needs.filter((n) => n.accepted || accepting.done.has(n.id));
  const valued = tasks.filter((t) => t.valued);
  const title = new Map(tasks.map((t) => [t.id, t.title]));
  return (
    <>
      {now.length > 0 && (
        <Section title="Working on now">
          <ul className="flex flex-wrap gap-2.5">
            {now.map((t) => (
              <li key={t.id}>
                <Link
                  to={search(t.id)}
                  className="flex min-w-60 items-start gap-3 rounded-xl bg-info-tint px-3.5 py-2.5 text-ui hover:ring-1 hover:ring-info"
                >
                  <TaskMark state={t.state} className="mt-1" />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{t.title}</span>
                    <span className="flex gap-2 text-muted-foreground">
                      {doingNow(t)}
                      {t.latest && t.state !== "paused" && <Elapsed thread={t.latest} />}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Needs your eye" count={open.length + failed.length}>
        {open.length + failed.length === 0 ? (
          <p className="text-ui text-muted-foreground">
            {looked.length > 0
              ? "You've looked at everything."
              : ended
                ? "Nothing to check."
                : "Nothing yet."}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-2.5">
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

      <Link to={search(undefined, "decisions")} className={buttonClass({ size: "sm" })}>
        What the AI decided
      </Link>
    </>
  );
}

/** A running task's line: what kind of work is under way, in the researcher's words. */
export function doingNow(t: TaskView): string {
  if (t.state === "checking") return "A second AI is checking the result";
  if (t.state === "paused") return "Paused until the run resumes";
  return t.redone ? "Redoing it after the second AI check" : "Working";
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
        {count ? (
          <span className="rounded-full border border-check-line bg-check-tint px-2 text-ui font-medium text-check-strong">
            {count}
          </span>
        ) : null}
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
}: {
  runId: string;
  asset: Asset;
  className?: string;
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
          className="size-full object-cover"
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
        <p className="text-ui font-medium text-check-strong">{item.title}</p>
        <p
          title={item.text}
          className="mt-1 mb-2.5 line-clamp-4 text-ui text-foreground [overflow-wrap:anywhere]"
        >
          {plain(item.text)}
        </p>
        <div className="flex flex-wrap gap-2">
          {accepting.enabled && item.acceptable && (
            <Button
              size="sm"
              disabled={accepting.pending === item.id}
              onClick={() => accepting.accept(item)}
            >
              {accepting.pending === item.id ? "Saving…" : "Looks right"}
            </Button>
          )}
          <Link to={reviewHref(runId, item.taskId)} className={buttonClass({ size: "sm" })}>
            Open in 3D
          </Link>
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
            {n.title}
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
  paused: "paused",
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
                    <span className="ml-1 text-meta text-muted-foreground">{r.unit}</span>
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

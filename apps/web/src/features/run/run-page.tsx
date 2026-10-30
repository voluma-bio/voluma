/**
 * The live run (`/runs/:id/live`): the run's status with Stop, what needs attention, the main
 * thread's transcript (the run's orchestration, with each worker and checker as a card), the
 * workers and checkers running now, and the run's progress in a rail: each task's state and
 * outcome, and the values reported so far. `?thread=<id>` shows that thread's own transcript in
 * place of the main one. Everything is derived from the run's stream:
 * durable events (`run-model.ts`, `transcript.ts`, and `@voluma/contracts/fold` for task status)
 * plus live frames for the reply being written.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, cancelRun, getRun, resendKeys, subscribe } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import type { RunEvent } from "@voluma/contracts/events";
import { fold } from "@voluma/contracts/fold";
import type { Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { workflowName } from "@voluma/workflow/bundled";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentMark, Elapsed, RunningStrip, ThreadCost, ThreadSpendInfo } from "./agents";
import { DisclosureProvider } from "./chat/disclosure-store";
import { ProcessDisclosure } from "./chat/process-disclosure";
import { ThreadNavigationProvider, useOpenThread } from "./chat/thread-navigation";
import { KeysForm } from "./keys";
import {
  type Attention,
  haltOf,
  runView,
  type Thread,
  threadName,
  withLiveCalls,
} from "./run-model";
import { RunSpendSummary } from "./spend";
import { RunBadge, runStatus } from "./status";
import { OutputList, TaskList } from "./task-progress";
import {
  applyFrame,
  type Live,
  mainRows,
  noLive,
  type Settled,
  settle,
  threadRows,
} from "./transcript";
import { TranscriptView } from "./transcript-view";

/**
 * The run's stream as it arrives: durable events, and live frames folded until their durable
 * event lands. Published at most once per animation frame: a busy run sends many per second.
 * `events` keeps its identity while only frames arrive, so the event derivations don't rerun
 * per token. `closed` once the stream is over for good, when the log is whole; live partials are
 * dropped then: nothing will complete them.
 */
function useRunStream(
  runId: string,
  onClosed: () => void,
): { events: RunEvent[]; live: Live; closed: boolean } {
  const [state, setState] = useState<{ events: RunEvent[]; live: Live; closed: boolean }>({
    events: [],
    live: noLive,
    closed: false,
  });
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    const events: RunEvent[] = [];
    let published: RunEvent[] = [];
    let live = noLive;
    let closed = false;
    const settled: Settled = new Set();
    let frame: number | undefined;
    const publish = () => {
      frame = undefined;
      if (published.length !== events.length) published = [...events];
      setState({ events: published, live, closed });
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(publish);
    };
    const stop = subscribe(runId, {
      onEvent: (event) => {
        events.push(event);
        live = settle(live, event, settled);
        schedule();
      },
      onLive: (f) => {
        const next = applyFrame(live, f, settled);
        if (next === live) return;
        live = next;
        schedule();
      },
      onClosed: () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        live = noLive;
        closed = true;
        publish();
        onClosedRef.current();
      },
    });
    return () => {
      stop();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [runId]);
  return state;
}

export function RunPage() {
  const { id = "" } = useParams();
  const me = useOutletContext<Me>();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    // Queue position and state changes aren't events; the stream is the source for the rest.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const { events, live, closed } = useRunStream(id, () => void run.refetch());
  const state = run.data?.state;
  // Query's structural sharing keeps `state` the same object across polls that change nothing.
  const halt = useMemo(() => state && haltOf(state, closed), [state, closed]);
  const folded = useMemo(() => fold(events), [events]);
  const providerCalls = run.data?.providerCalls;
  const view = useMemo(
    () => runView(events, folded, halt, providerCalls),
    [events, folded, halt, providerCalls],
  );
  const threads = useMemo(() => withLiveCalls(view.threads, live), [view.threads, live]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  // The root thread spans the run; the main agent's threads (`main`, `main.2`, ...) are the page's transcript.
  const root = threads.find((t) => t.kind === "supervisor");
  const openId = params.get("thread");
  const opened = openId ? threadById.get(openId) : undefined;
  const open = opened?.kind === "main" || opened?.kind === "supervisor" ? undefined : opened;
  const rows = useMemo(
    () => (open ? threadRows(events, open.id, live, halt) : mainRows(events, live, halt)),
    [events, live, halt, open],
  );
  const openThread = useCallback(
    (threadId: string | null) => setParams(threadId ? { thread: threadId } : {}),
    [setParams],
  );

  if (run.isPending) return <Message>Loading run…</Message>;
  if (run.isError) {
    return (
      <Message>
        {run.error instanceof ApiError && run.error.status === 404
          ? "This run doesn't exist, or you can't open it."
          : "Couldn't load this run."}{" "}
        <Link to="/" className="text-primary-text hover:underline">
          Go to Home
        </Link>
      </Message>
    );
  }

  const data = run.data;
  const ended = halt?.kind === "ended";
  const { attention, plan, tasks, outputs, progress, spend } = view;
  const setRun = (next: Run) => queryClient.setQueryData(["run", id], next);
  const progressPanel = plan && (
    <>
      <TaskList tasks={tasks} />
      <OutputList outputs={outputs} />
    </>
  );
  const tasksLabel = plan ? `Tasks: ${progress}` : "Tasks";

  return (
    <DisclosureProvider>
      <ThreadNavigationProvider onOpenThread={openThread}>
        <main className="flex min-h-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-6 py-3 max-[1100px]:px-4">
            <h1 className="text-lg font-semibold">{data.input.name}</h1>
            <RunBadge run={data} />
            <span className="min-w-0 truncate text-ui text-muted-foreground">
              {workflowName(data.workflows[0]?.path)}
              {runStatus(data).detail ? `, ${runStatus(data).detail}` : ""}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <RunSpendSummary
                spend={spend}
                since={root?.status === "running" ? events.at(-1)?.createdAt : undefined}
              />
              <RunActions run={data} onChange={setRun} />
            </span>
          </header>
          <RunAlerts run={data} userId={me.userId} onChange={setRun} />

          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col">
              <AttentionStrip items={attention} />
              {plan && (
                <div className="hidden border-b border-border px-4 py-1 max-[1100px]:block">
                  <ProcessDisclosure label={tasksLabel}>
                    <div className="max-h-[50dvh] overflow-y-auto pr-1 pb-2">{progressPanel}</div>
                  </ProcessDisclosure>
                </div>
              )}
              {open ? (
                <ThreadBar thread={open} />
              ) : (
                <div className="px-6 max-[1100px]:px-4">
                  <RunningStrip
                    threads={threads.filter(
                      (t) => t.status === "running" && (t.kind === "worker" || t.kind === "check"),
                    )}
                  />
                </div>
              )}
              {openId && !opened ? (
                <Message>This thread isn't in the run yet.</Message>
              ) : (
                <TranscriptView
                  key={open?.id ?? "main"}
                  rows={rows}
                  threads={threadById}
                  live={
                    open
                      ? open.status === "running"
                        ? (open.liveTool ?? "Thinking")
                        : null
                      : !halt && events.length > 0
                        ? ""
                        : null
                  }
                  empty={
                    ended
                      ? "This run ended before it started."
                      : open
                        ? "Nothing has happened in this thread yet."
                        : "The run's story appears here once it starts."
                  }
                />
              )}
            </section>
            <aside
              aria-label="Tasks"
              className="w-[23rem] shrink-0 overflow-y-auto border-l border-border px-5 py-4 max-[1100px]:hidden"
            >
              <h2 className="mb-3 text-ui font-medium">
                Tasks
                {plan && <span className="ml-2 font-normal text-muted-foreground">{progress}</span>}
              </h2>
              {progressPanel ?? (
                <p className="text-ui text-muted-foreground">
                  {ended
                    ? "This run ended before it made a plan."
                    : "The tasks appear when the run starts."}
                </p>
              )}
            </aside>
          </div>
        </main>
      </ThreadNavigationProvider>
    </DisclosureProvider>
  );
}

/** Above an opened thread: the way back, its name, state and clock, and its usage. */
function ThreadBar({ thread }: { thread: Thread }) {
  const open = useOpenThread();
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border px-6 py-2 max-[1100px]:px-4">
      <button
        type="button"
        onClick={() => open(null)}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-ui text-primary-text hover:bg-accent"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Main thread
      </button>
      <span className="text-fg-subtle" aria-hidden>
        /
      </span>
      <AgentMark thread={thread} />
      <h2 className="min-w-0 truncate text-ui font-medium">{threadName(thread)}</h2>
      <span className="ml-auto" />
      <ThreadCost thread={thread} />
      <Elapsed thread={thread} />
      <ThreadSpendInfo thread={thread} />
    </div>
  );
}

/** What needs a person first: failures, To check items and checks that want review. */
function AttentionStrip({ items }: { items: Attention[] }) {
  const open = useOpenThread();
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Needs attention"
      className="grid gap-1 border-b border-border px-6 py-2 max-[1100px]:px-4"
    >
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          onClick={() => open(i.threadId)}
          className={`truncate rounded-lg px-3 py-1.5 text-left text-ui hover:underline ${
            i.tone === "check"
              ? "bg-check-tint text-check-strong"
              : "bg-destructive-tint text-destructive"
          }`}
        >
          {i.text}
        </button>
      ))}
    </section>
  );
}

function OpenReview({ runId, primary }: { runId: string; primary?: boolean }) {
  return (
    <Link
      to={`/runs/${runId}`}
      className={`inline-flex h-8 items-center rounded-lg px-3.5 text-ui font-medium ${
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary-strong"
          : "border border-border hover:bg-muted"
      }`}
    >
      Open review
    </Link>
  );
}

/** Open review once the run has started, or once completed; Stop, with a confirm, while the run is not over. */
function RunActions({ run, onChange }: { run: Run; onChange: (run: Run) => void }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: onChange });
  const { state } = run;
  if (state.status === "ended")
    return state.outcome === "completed" ? <OpenReview runId={run.id} primary /> : null;
  return (
    <>
      {state.status !== "queued" && state.startedAt && <OpenReview runId={run.id} />}
      {cancel.isError && (
        <span role="alert" className="text-ui text-destructive">
          Couldn't stop the run. Try again.
        </span>
      )}
      {confirming ? (
        <>
          <span className="text-ui">Stop this run?</span>
          <Button
            size="sm"
            variant="quiet"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? "Stopping…" : "Stop run"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep running
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => setConfirming(true)}>
          Stop run
        </Button>
      )}
    </>
  );
}

/** The run's own problems: it is waiting for the keys of the user who started it, or it failed. */
function RunAlerts({
  run,
  userId,
  onChange,
}: {
  run: Run;
  userId: string;
  onChange: (run: Run) => void;
}) {
  const resend = useMutation({
    mutationFn: (keys: Parameters<typeof resendKeys>[1]) => resendKeys(run.id, keys),
    onSuccess: onChange,
  });
  const { state } = run;
  if (state.status === "awaiting-keys" && run.startedBy === userId)
    return (
      <section className="mx-6 mt-3 max-w-sm rounded-xl border border-check-line bg-check-tint p-4">
        <h2 className="font-medium text-check-strong">The run is waiting for your keys</h2>
        <p className="mt-1 mb-3 text-ui text-check-strong">
          The server restarted and no longer has them. Send them again to continue.
        </p>
        <KeysForm
          userId={userId}
          submitLabel="Continue the run"
          busy={resend.isPending}
          onSubmit={(keys) => resend.mutate(keys)}
        />
        {resend.isError && (
          <p role="alert" className="mt-2 text-ui text-destructive">
            {resend.error instanceof ApiError && resend.error.status === 429
              ? "Too many runs are waiting right now. Try again shortly."
              : "Couldn't send the keys. Try again."}
          </p>
        )}
      </section>
    );
  if (state.status === "ended" && state.outcome === "failed" && state.error)
    return (
      <p
        role="alert"
        className="border-b border-border bg-destructive-tint px-6 py-2 text-ui text-destructive"
      >
        {state.error}
      </p>
    );
  return null;
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="px-10 py-8 text-ui text-muted-foreground">{children}</p>;
}

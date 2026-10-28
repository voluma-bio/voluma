/**
 * The live run (`/runs/:id/live`): the run's status with Stop, what needs attention, the main
 * thread's transcript (the run's orchestration, with each worker and checker as a card), the
 * workers and checkers running now, and the plan as a compact graph. `?thread=<id>` shows that
 * thread's own transcript in place of the main one. Everything is derived from the run's stream:
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
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentMark, Elapsed, RunningStrip } from "./chat/agents";
import { DisclosureProvider } from "./chat/disclosure-store";
import { InfoButton, usageRows } from "./chat/info-button";
import { ProcessDisclosure } from "./chat/process-disclosure";
import { ThreadNavigationProvider, useOpenThread } from "./chat/thread-navigation";
import { KeysForm } from "./keys";
import {
  type Attention,
  addUsage,
  attentionOf,
  latestThreadByTask,
  planOf,
  type TaskState,
  type Thread,
  taskStates,
  threadName,
  threadsOf,
} from "./run-model";
import { RunBadge, runStatus } from "./status";
import { TaskGraph } from "./task-graph";
import { applyFrame, type Live, mainRows, noLive, settle, threadRows } from "./transcript";
import { TranscriptView } from "./transcript-view";
import { workflowName } from "./workflows";

/**
 * The run's stream as it arrives: durable events, and live frames folded until their durable
 * event lands. Published at most once per animation frame: a busy run sends many per second.
 */
function useRunStream(runId: string, onClosed: () => void): { events: RunEvent[]; live: Live } {
  const [state, setState] = useState<{ events: RunEvent[]; live: Live }>({
    events: [],
    live: noLive,
  });
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    const events: RunEvent[] = [];
    let live = noLive;
    let frame: number | undefined;
    const publish = () => {
      frame = undefined;
      setState({ events: [...events], live });
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(publish);
    };
    const stop = subscribe(runId, {
      onEvent: (event) => {
        events.push(event);
        live = settle(live, event);
        schedule();
      },
      onLive: (f) => {
        const next = applyFrame(live, f);
        if (next === live) return;
        live = next;
        schedule();
      },
      onClosed: () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        publish();
        closed.current();
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
  const { events, live } = useRunStream(id, () => void run.refetch());
  const folded = useMemo(() => fold(events), [events]);
  const threads = useMemo(() => threadsOf(events, live), [events, live]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const attention = useMemo(() => attentionOf(events), [events]);
  const main = threads.find((t) => t.kind === "supervisor");
  const openId = params.get("thread");
  const open = openId && openId !== main?.id ? threadById.get(openId) : undefined;
  const rows = useMemo(
    () =>
      openId && openId !== main?.id ? threadRows(events, openId, live) : mainRows(events, live),
    [events, live, openId, main?.id],
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
        <Link to="/runs" className="text-primary-text hover:underline">
          Back to runs
        </Link>
      </Message>
    );
  }

  const data = run.data;
  const ended = data.state.status === "ended";
  const plan = planOf(events);
  const states = plan
    ? taskStates(plan, new Map(folded.tasks.map((t) => [t.id, t.status])))
    : new Map<string, TaskState>();
  // To check is finished too: the work is done and a person has items to look at.
  const done = [...states.values()].filter((s) => s === "done" || s === "to-check").length;
  const toCheck = [...states.values()].filter((s) => s === "to-check").length;
  const progress = plan
    ? `${done} of ${plan.tasks.length} finished${toCheck > 0 ? `, ${toCheck} to check` : ""}`
    : "";
  const setRun = (next: Run) => queryClient.setQueryData(["run", id], next);
  const usage = threads.reduce<Thread["usage"]>(
    (sum, t) => (t.usage ? addUsage(sum, t.usage) : sum),
    undefined,
  );
  const graph = plan && (
    <TaskGraph plan={plan} states={states} threadByTask={latestThreadByTask(threads)} />
  );
  const tasksLabel = plan ? `Tasks: ${progress}` : "Tasks";

  return (
    <DisclosureProvider>
      <ThreadNavigationProvider onOpenThread={openThread}>
        <main className="flex min-h-0 flex-1 flex-col max-[1100px]:h-[calc(100dvh-3.5rem)] max-[1100px]:flex-none">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-6 py-3 max-[1100px]:px-4">
            <Link to="/runs" className="text-ui text-primary-text hover:underline">
              Runs
            </Link>
            <span className="text-fg-subtle" aria-hidden>
              /
            </span>
            <h1 className="text-lg font-semibold">{data.input.name}</h1>
            <RunBadge run={data} />
            <span className="min-w-0 truncate text-ui text-muted-foreground">
              {workflowName(data.workflows[0]?.path)}
              {runStatus(data).detail ? `, ${runStatus(data).detail}` : ""}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {usage && (
                <InfoButton
                  label="Run usage"
                  sections={[{ title: "Every model call so far", rows: usageRows(usage) }]}
                />
              )}
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
                    <div className="overflow-x-auto pb-2">{graph}</div>
                  </ProcessDisclosure>
                </div>
              )}
              {open ? (
                <ThreadBar thread={open} />
              ) : (
                <div className="px-6 max-[1100px]:px-4">
                  <RunningStrip
                    threads={threads.filter(
                      (t) => t.status === "running" && t.kind !== "supervisor",
                    )}
                  />
                </div>
              )}
              {openId && !open && openId !== main?.id ? (
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
                      : !ended && events.length > 0
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
              {graph ?? (
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
      <Elapsed thread={thread} />
      {thread.usage && (
        <InfoButton
          label="Thread usage"
          sections={[
            { title: `${thread.calls} model calls`, rows: usageRows(thread.usage, thread.model) },
          ]}
        />
      )}
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

/** Open review once completed; Stop, with a confirm, while the run is not over. */
function RunActions({ run, onChange }: { run: Run; onChange: (run: Run) => void }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: onChange });
  const { state } = run;
  if (state.status === "ended")
    return state.outcome === "completed" ? (
      <Link
        to={`/runs/${run.id}`}
        className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-ui font-medium text-primary-foreground hover:bg-primary-strong"
      >
        Open review
      </Link>
    ) : null;
  return (
    <>
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

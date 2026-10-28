/**
 * The live run (`/runs/:id/live`): the run's status with cancel, a task rail, the orchestration
 * feed and, beside it, the open thread (`?thread=<id>`). Everything is derived from the run's
 * events (`run-feed.ts`, and `@voluma/contracts/fold` for task status, the same one the review reads).
 * Live granularity is one event: a message or a tool call appears whole, not token by token.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, cancelRun, getRun, resendKeys, subscribe } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import type { RunEvent } from "@voluma/contracts/events";
import { fold } from "@voluma/contracts/fold";
import type { Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { Feed } from "./feed";
import { Follow } from "./follow";
import { KeysForm } from "./keys";
import { Lanes } from "./lanes";
import {
  feedOf,
  latestThreadByTask,
  planOf,
  type TaskState,
  taskStates,
  threadsOf,
} from "./run-feed";
import { RunBadge, runStatus } from "./status";
import { TaskGraph } from "./task-graph";
import { ThreadView } from "./thread-view";
import { workflowName } from "./workflows";

/** Events as they arrive, published at most every 200 ms: a busy run emits many per second. */
function useRunEvents(runId: string, onClosed: () => void): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    const received: RunEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribe(runId, {
      onEvent: (event) => {
        received.push(event);
        timer ??= setTimeout(() => {
          timer = undefined;
          setEvents([...received]);
        }, 200);
      },
      onClosed: () => {
        clearTimeout(timer);
        timer = undefined;
        setEvents([...received]);
        closed.current();
      },
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [runId]);
  return events;
}

export function RunPage() {
  const { id = "" } = useParams();
  const me = useOutletContext<Me>();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    // Queue position and state changes aren't events; the stream is the source for the rest.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const events = useRunEvents(id, () => void run.refetch());
  const folded = useMemo(() => fold(events), [events]);
  const threads = useMemo(() => threadsOf(events), [events]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const entries = useMemo(() => feedOf(events), [events]);
  const [hover, setHover] = useState<string | null>(null);

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
  const plan = planOf(events);
  const states = plan
    ? taskStates(plan, new Map(folded.tasks.map((t) => [t.id, t.status])))
    : new Map<string, TaskState>();
  const threadByTask = latestThreadByTask(threads);
  const openId = params.get("thread");
  const open = openId ? threadById.get(openId) : undefined;
  const setRun = (next: Run) => queryClient.setQueryData(["run", id], next);
  const ended = data.state.status === "ended";

  return (
    <main className="flex min-h-0 flex-1 flex-col px-8 py-5 max-[1100px]:px-4">
      <div className={openId ? "max-[1100px]:hidden" : undefined}>
        <Link to="/runs" className="text-ui text-primary-text hover:underline">
          Runs
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{data.input.name}</h1>
          <RunBadge run={data} />
          <span className="text-muted-foreground">
            {workflowName(data.workflows[0]?.path)}
            {runStatus(data).detail ? `, ${runStatus(data).detail}` : ""}
          </span>
        </div>
        <RunActions run={data} userId={me.userId} onChange={setRun} />
      </div>

      <div
        className={`mt-4 grid min-h-0 flex-1 gap-5 max-[1100px]:block ${
          openId ? "grid-cols-[minmax(0,1fr)_minmax(26rem,38rem)]" : "grid-cols-[minmax(0,1fr)]"
        }`}
      >
        <div
          className={`flex min-h-0 min-w-0 flex-col gap-4 max-[1100px]:block max-[1100px]:space-y-4 ${
            openId ? "max-[1100px]:hidden" : ""
          }`}
        >
          {plan ? (
            <TaskGraph
              plan={plan}
              states={states}
              threadByTask={threadByTask}
              openThread={openId}
              hover={hover}
              onHover={setHover}
            />
          ) : (
            <p className="text-ui text-muted-foreground">
              {ended
                ? "This run ended before it made a plan."
                : "The task list appears when the run starts."}
            </p>
          )}
          <Lanes
            threads={threads.filter((t) => t.status === "running" && t.kind !== "supervisor")}
            openThread={openId}
            hover={hover}
          />
          <Follow changes={entries.length} resetKey={id}>
            {entries.length === 0 ? (
              <p className="text-ui text-muted-foreground">
                {ended
                  ? "This run ended before it started."
                  : "The run's story appears here once it starts."}
              </p>
            ) : (
              <>
                <h2 className="mb-2 text-ui font-medium">The run so far</h2>
                <Feed entries={entries} threads={threadById} openThread={openId} hover={hover} />
              </>
            )}
          </Follow>
        </div>
        {openId &&
          (open ? (
            <ThreadView events={events} thread={open} closeTo="?" />
          ) : (
            <p className="text-ui text-muted-foreground">
              This thread isn't in the run yet.{" "}
              <Link to="?" className="text-primary-text hover:underline">
                Back to the run
              </Link>
            </p>
          ))}
      </div>
    </main>
  );
}

function RunActions({
  run,
  userId,
  onChange,
}: {
  run: Run;
  userId: string;
  onChange: (run: Run) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: onChange });
  const resend = useMutation({
    mutationFn: (keys: Parameters<typeof resendKeys>[1]) => resendKeys(run.id, keys),
    onSuccess: onChange,
  });
  const { state } = run;

  return (
    <div className="mt-3 grid gap-3">
      {state.status === "awaiting-keys" && run.startedBy === userId && (
        <section className="max-w-sm rounded-xl border border-check-line bg-check-tint p-4">
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
      )}

      {state.status === "ended" && state.outcome === "failed" && state.error && (
        <p role="alert" className="rounded-xl bg-destructive-tint p-3 text-ui text-destructive">
          {state.error}
        </p>
      )}

      {state.status === "ended" && state.outcome === "completed" && (
        <div>
          <Link
            to={`/runs/${run.id}`}
            className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-strong"
          >
            Open review
          </Link>
        </div>
      )}

      {state.status !== "ended" &&
        (confirming ? (
          <div className="flex items-center gap-2 text-ui">
            Stop this run?
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
          </div>
        ) : (
          <div>
            <Button size="sm" onClick={() => setConfirming(true)}>
              Stop run
            </Button>
          </div>
        ))}
      {cancel.isError && (
        <p role="alert" className="text-ui text-destructive">
          Couldn't stop the run. Try again.
        </p>
      )}
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="px-10 py-8 text-ui text-muted-foreground">{children}</p>;
}

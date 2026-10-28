/**
 * The live run (`/runs/:id/live`): the run's status with cancel, and the plan's tasks with their
 * status as the event stream moves them. The task list is the fold of the run's events
 * (`@voluma/contracts/fold`), the same one the review reads.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, cancelRun, getRun, resendKeys, subscribe } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import { type FoldedTask, fold } from "@voluma/contracts/fold";
import type { Run } from "@voluma/contracts/run";
import { Button, StatusBadge } from "@voluma/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { KeysForm } from "./keys";
import { RunBadge, runStatus, taskStatus } from "./status";
import { taskTitle, workflowName } from "./workflows";

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
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    // Queue position and state changes aren't events; the stream is the source for tasks only.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const events = useRunEvents(id, () => void run.refetch());
  const folded = useMemo(() => fold(events), [events]);

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
  const first = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  const planTasks =
    first?.type === "revision.started" && first.payload.reason === "run"
      ? first.payload.plan.tasks
      : [];
  const byId = new Map(folded.tasks.map((t) => [t.id, t]));
  const done = planTasks.filter((t) => byId.get(t.id)?.status === "done").length;
  const toCheck = planTasks.filter((t) => byId.get(t.id)?.status === "to-check").length;
  const setRun = (next: Run) => queryClient.setQueryData(["run", id], next);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-10 py-8 max-[1100px]:px-5">
      <div className="mx-auto max-w-3xl">
        <Link to="/runs" className="text-ui text-primary-text hover:underline">
          Runs
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{data.input.name}</h1>
          <RunBadge run={data} />
        </div>
        <p className="mt-1 text-muted-foreground">
          {workflowName(data.workflows[0]?.path)}
          {runStatus(data).detail ? `, ${runStatus(data).detail}` : ""}
        </p>

        <RunActions run={data} onChange={setRun} />

        <h2 className="mt-8 mb-3 flex items-baseline gap-3 text-lg font-semibold">
          Tasks
          {planTasks.length > 0 && (
            <span className="text-ui font-normal text-muted-foreground">
              {done} of {planTasks.length} done
              {toCheck > 0 && `, ${toCheck} to check`}
            </span>
          )}
        </h2>
        {planTasks.length === 0 ? (
          <p className="text-ui text-muted-foreground">
            {data.state.status === "ended"
              ? "This run ended before it made a plan."
              : "The task list appears when the run starts."}
          </p>
        ) : (
          <ol className="grid gap-2">
            {planTasks.map((t, i) => (
              <TaskRow
                key={t.id}
                index={i + 1}
                id={t.id}
                task={byId.get(t.id)}
                outputs={t.outputs.length}
              />
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}

function TaskRow({
  index,
  id,
  task,
  outputs,
}: {
  index: number;
  id: string;
  task: FoldedTask | undefined;
  outputs: number;
}) {
  const { label, tone } = taskStatus(task?.status);
  return (
    <li className="flex items-start gap-4 rounded-xl border border-border bg-card p-4">
      <span className="w-5 pt-px text-ui text-fg-subtle tabular-nums">{index}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{taskTitle(id)}</p>
        <p className="text-meta text-muted-foreground">
          {outputs} {outputs === 1 ? "output" : "outputs"}
        </p>
        {task?.reason && <p className="mt-1 text-ui text-muted-foreground">{task.reason}</p>}
      </div>
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </li>
  );
}

function RunActions({ run, onChange }: { run: Run; onChange: (run: Run) => void }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: onChange });
  const resend = useMutation({
    mutationFn: (keys: Parameters<typeof resendKeys>[1]) => resendKeys(run.id, keys),
    onSuccess: onChange,
  });
  const { state } = run;

  return (
    <div className="mt-5 grid gap-3">
      {state.status === "awaiting-keys" && (
        <section className="max-w-sm rounded-xl border border-check-line bg-check-tint p-4">
          <h2 className="font-medium text-check-strong">The run is waiting for your keys</h2>
          <p className="mt-1 mb-3 text-ui text-check-strong">
            The server restarted and no longer has them. Send them again to continue.
          </p>
          <KeysForm
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

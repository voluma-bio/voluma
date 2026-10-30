/**
 * The run page (`/runs/:id/live`): a header with where the run is and what is left to check, the
 * plan's tasks as a flowchart, and beside it the Overview (working on now, needs your eye,
 * results), one task (`?task=<id>`), or every agent of the run with one agent's stream
 * (`?view=agents`, `&agent=<threadId>`; none picked follows whoever works now).
 * Everything is derived from the run's stream (`run-model.ts`, `transcript.ts`) and `getRun`,
 * polled for what isn't an event (queue place, state, review progress).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, subscribe } from "@voluma/api-client";
import { runQuery, studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { RunEvent } from "@voluma/contracts/events";
import type { Run } from "@voluma/contracts/run";
import {
  applyFrame,
  DisclosureProvider,
  haltOf,
  noLive,
  RunStoreProvider,
  runView,
  type Settled,
  settle,
  TaskFlow,
  ThreadNavigationProvider,
  useClosed,
  useEvents,
  useRunStore,
} from "@voluma/run-view";
import { Button, EmptyState, ErrorState, LoadingState } from "@voluma/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentsView } from "./agents-view";
import { Overview, useAccepting } from "./overview";
import { RunAlerts, RunHeader } from "./run-header";
import { TaskView } from "./task-view";

/**
 * Feeds the run's stream into the run store: durable events, and live frames folded until their
 * durable event lands. Published at most once per animation frame: a busy run sends many per
 * second. `events` keeps its identity while only frames arrive, so the event derivations don't
 * rerun per token. Once the stream is over for good, live partials are dropped: nothing will
 * complete them.
 */
function useRunStream(runId: string, onClosed: () => void) {
  const store = useRunStore();
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
      store.set({ events: published, live, closed });
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
  }, [runId, store]);
}

/** Keyed on the run: nothing of one run's stream or decisions carries over to the next. */
export function RunPage() {
  const { id = "" } = useParams();
  return (
    <RunStoreProvider key={id}>
      <RunOf id={id} />
    </RunStoreProvider>
  );
}

function RunOf({ id }: { id: string }) {
  const me = useOutletContext<Me>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const run = useQuery({
    ...runQuery(id),
    // Queue position and state changes aren't events; the stream is the source for the rest.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const studyId = run.data?.studyId;
  // Labels only (the study's name and size, the scan's mouse, knee and group): read once.
  const study = useQuery({
    ...studyQuery(studyId ?? ""),
    enabled: studyId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const store = useRunStore();
  useRunStream(id, () => void run.refetch());
  const events = useEvents();
  const closed = useClosed();
  const state = run.data?.state;
  // Query's structural sharing keeps `state` the same object across polls that change nothing.
  const halt = useMemo(() => state && haltOf(state, closed), [state, closed]);
  const providerCalls = run.data?.providerCalls;
  // Not shown until the run has loaded; until then any state will do.
  const view = useMemo(
    () => runView(events, state ?? { status: "queued", position: 1 }, providerCalls, halt),
    [events, state, providerCalls, halt],
  );
  // Layout effect: the agent views below read these from the store and must not paint without them.
  useLayoutEffect(
    () => store.set({ halt, baseThreads: view.threads }),
    [store, halt, view.threads],
  );
  const base = `/runs/${encodeURIComponent(id)}/live`;
  const search = useCallback(
    (taskId?: string, v?: "agents") =>
      taskId ? `${base}?task=${encodeURIComponent(taskId)}` : v ? `${base}?view=${v}` : base,
    [base],
  );
  // Every door onto an agent (a card's name, the Agents tree) opens its stream; null follows live.
  const openThread = useCallback(
    (threadId: string | null) =>
      navigate(
        threadId
          ? `${search(undefined, "agents")}&agent=${encodeURIComponent(threadId)}`
          : search(undefined, "agents"),
      ),
    [navigate, search],
  );
  const setRun = useCallback(
    (next: Run | ((run: Run) => Run)) =>
      queryClient.setQueryData<Run>(runQuery(id).queryKey, (run) =>
        typeof next === "function" ? run && next(run) : next,
      ),
    [queryClient, id],
  );
  const refetch = useCallback(() => void run.refetch(), [run.refetch]);

  if (run.isPending)
    return (
      <div className={PAGE_STATE}>
        <LoadingState label="Loading the run" rows={4} />
      </div>
    );
  if (!run.data) {
    const missing = run.error instanceof ApiError && run.error.status === 404;
    return (
      <div className={PAGE_STATE}>
        <ErrorState
          title={missing ? "This run isn't here" : "Couldn't load the run"}
          onRetry={missing ? undefined : refetch}
        >
          {missing
            ? "It may have been removed, or you can't open it. "
            : "Check your connection, then try again. "}
          <Button asChild variant="link">
            <Link to="/">Go to Home</Link>
          </Button>
        </ErrorState>
      </div>
    );
  }
  return (
    <RunScreen
      run={run.data}
      stale={run.isError}
      study={study.data}
      me={me}
      view={view}
      params={params}
      search={search}
      openThread={openThread}
      setRun={setRun}
    />
  );
}

function RunScreen({
  run,
  stale,
  study,
  me,
  view,
  params,
  search,
  openThread,
  setRun,
}: {
  run: Run;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  study: Parameters<typeof RunHeader>[0]["study"];
  me: Me;
  view: ReturnType<typeof runView>;
  params: URLSearchParams;
  search: (taskId?: string, v?: "agents") => string;
  openThread: (threadId: string | null) => void;
  setRun: (next: Run | ((run: Run) => Run)) => void;
}) {
  const accepting = useAccepting(run, setRun);
  const { tasks } = view;
  const taskId = params.get("task") ?? undefined;
  const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  const agents = !taskId && params.get("view") === "agents";
  const ended = run.state.status === "ended";
  const titles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const needs = tasks.flatMap((t) => t.needs);
  // An ended run's stream is closed, so a "Looks right" made here counts from `accepting.done`.
  // An ended run that takes no decisions (failed, cancelled, an example) has nothing to count.
  const toCheck =
    ended && !accepting.enabled
      ? 0
      : view.progress.toCheck -
        needs.filter((n) => n.acceptable && !n.accepted && accepting.done.has(n.id)).length;
  const firstOpen = needs.find((n) => !n.accepted && !accepting.done.has(n.id));

  let content: React.ReactNode;
  if (taskId && !task)
    content = (
      <div className={PAGE_STATE}>
        {tasks.length === 0 ? (
          <EmptyState title="No tasks yet">The tasks appear when the run starts.</EmptyState>
        ) : (
          <ErrorState title="This task isn't in the run's plan" />
        )}
      </div>
    );
  else if (task)
    content = (
      <TaskView
        runId={run.id}
        task={task}
        titleOf={(t) => titles.get(t) ?? t}
        accepting={accepting}
        search={search}
      />
    );
  else if (agents) {
    const agentId = params.get("agent") ?? undefined;
    content = <AgentsView agentId={agentId} select={openThread} ended={ended} />;
  } else if (tasks.length === 0)
    content = (
      <EmptyState title={ended ? "This run ended before it made a plan" : "No tasks yet"}>
        {ended ? undefined : "The tasks appear when the run starts."}
      </EmptyState>
    );
  else
    content = (
      <Overview
        runId={run.id}
        tasks={tasks}
        toCheck={toCheck}
        ended={ended}
        example={run.example}
        accepting={accepting}
        search={search}
      />
    );

  return (
    <DisclosureProvider>
      <ThreadNavigationProvider onOpenThread={openThread}>
        <main className="flex min-h-0 flex-1 flex-col max-[1100px]:overflow-y-auto">
          <RunHeader
            run={run}
            study={study}
            progress={{ ...view.progress, toCheck }}
            spend={view.spend}
            openTask={task?.id ?? firstOpen?.taskId}
            agents={search(undefined, "agents")}
            onChange={setRun}
          />
          {stale && (
            <p
              role="status"
              className="border-b border-border bg-muted px-6 py-1.5 text-meta text-muted-foreground max-[1100px]:px-4"
            >
              Couldn't reach the server. Showing what was loaded; retrying.
            </p>
          )}
          <div className="flex min-h-0 flex-1 max-[1100px]:flex-col">
            <TaskFlow tasks={tasks} selected={task?.id} search={search} link={Link} />
            {/* The Agents view fills the column and its threads scroll themselves; the rest scroll here. */}
            <div
              className={`min-h-0 min-w-0 flex-1 px-9 pt-6 max-[1100px]:overflow-visible max-[1100px]:px-4 max-[1100px]:pt-4 ${agents ? "flex flex-col overflow-hidden pb-6" : "overflow-y-auto pb-24"}`}
            >
              <div
                className={`mx-auto w-full ${agents ? "flex min-h-0 max-w-[80rem] flex-1 flex-col" : "max-w-[55rem]"}`}
              >
                <RunAlerts run={run} userId={me.userId} onChange={setRun} />
                {content}
              </div>
            </div>
          </div>
        </main>
      </ThreadNavigationProvider>
    </DisclosureProvider>
  );
}

/** Where loading, empty and error states sit while there is no run or task to show. */
const PAGE_STATE = "px-10 py-8";

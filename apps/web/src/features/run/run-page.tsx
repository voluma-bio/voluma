/**
 * The run page (`/runs/:id/live`): a header with where the run is and what is left to check, the
 * plan's tasks as a flowchart, and beside it the Overview (working on now, needs your eye,
 * results), one task (`?task=<id>`), or every agent of the run with one agent's stream
 * (`?view=agents`, `&agent=<threadId>`; none picked follows whoever works now).
 * Everything is derived from the run's stream (`run-model.ts`, `transcript.ts`) and `getRun`,
 * polled for what isn't an event (queue place, state, review progress).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getRun, getStudy, subscribe } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import type { RunEvent } from "@voluma/contracts/events";
import type { Run } from "@voluma/contracts/run";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentsView } from "./agents-view";
import { DisclosureProvider } from "./chat/disclosure-store";
import { ThreadNavigationProvider } from "./chat/thread-navigation";
import { Overview, useAccepting } from "./overview";
import { RunAlerts, RunHeader } from "./run-header";
import { haltOf, runView, withLiveCalls } from "./run-model";
import { TaskFlow } from "./task-flow";
import { TaskView } from "./task-view";
import { applyFrame, type Live, noLive, type Settled, settle } from "./transcript";

/**
 * The run's stream as it arrives: durable events, and live frames folded until their durable
 * event lands. Published at most once per animation frame: a busy run sends many per second.
 * `events` keeps its identity while only frames arrive, so the event derivations don't rerun
 * per token. Once the stream is over for good, live partials are dropped: nothing will complete them.
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

/** Keyed on the run: nothing of one run's stream or decisions carries over to the next. */
export function RunPage() {
  const { id = "" } = useParams();
  return <RunOf key={id} id={id} />;
}

function RunOf({ id }: { id: string }) {
  const me = useOutletContext<Me>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    // Queue position and state changes aren't events; the stream is the source for the rest.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  const studyId = run.data?.studyId;
  // Labels only (the study's name and size, the scan's mouse, knee and group): read once.
  const study = useQuery({
    queryKey: ["study", studyId],
    queryFn: () => getStudy(studyId ?? ""),
    enabled: studyId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { events, live, closed } = useRunStream(id, () => void run.refetch());
  const state = run.data?.state;
  // Query's structural sharing keeps `state` the same object across polls that change nothing.
  const halt = useMemo(() => state && haltOf(state, closed), [state, closed]);
  const providerCalls = run.data?.providerCalls;
  // Not shown until the run has loaded; until then any state will do.
  const view = useMemo(
    () => runView(events, state ?? { status: "queued", position: 1 }, providerCalls, halt),
    [events, state, providerCalls, halt],
  );
  const threads = useMemo(() => withLiveCalls(view.threads, live), [view.threads, live]);
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
      queryClient.setQueryData<Run>(["run", id], (run) =>
        typeof next === "function" ? run && next(run) : next,
      ),
    [queryClient, id],
  );
  const refetch = useCallback(() => void run.refetch(), [run.refetch]);

  if (run.isPending) return <Message>Loading run…</Message>;
  if (!run.data) {
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
  return (
    <RunScreen
      run={run.data}
      stale={run.isError}
      study={study.data}
      me={me}
      events={events}
      live={live}
      halt={halt}
      view={view}
      threads={threads}
      params={params}
      search={search}
      openThread={openThread}
      setRun={setRun}
      refetch={refetch}
    />
  );
}

function RunScreen({
  run,
  stale,
  study,
  me,
  events,
  live,
  halt,
  view,
  threads,
  params,
  search,
  openThread,
  setRun,
  refetch,
}: {
  run: Run;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  study: Parameters<typeof RunHeader>[0]["study"];
  me: Me;
  events: RunEvent[];
  live: Live;
  halt: ReturnType<typeof haltOf>;
  view: ReturnType<typeof runView>;
  threads: ReturnType<typeof withLiveCalls>;
  params: URLSearchParams;
  search: (taskId?: string, v?: "agents") => string;
  openThread: (threadId: string | null) => void;
  setRun: (next: Run | ((run: Run) => Run)) => void;
  refetch: () => void;
}) {
  const accepting = useAccepting(run, setRun, refetch);
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
      <Message>
        {tasks.length === 0
          ? "The tasks appear when the run starts."
          : "This task isn't in the run's plan."}
      </Message>
    );
  else if (task)
    content = (
      <TaskView
        runId={run.id}
        task={task}
        titleOf={(t) => titles.get(t) ?? t}
        accepting={accepting}
        search={search}
        events={events}
        live={live}
        halt={halt}
      />
    );
  else if (agents) {
    const agentId = params.get("agent") ?? undefined;
    content = (
      <AgentsView
        threads={threads}
        events={events}
        live={live}
        halt={halt}
        agentId={agentId}
        follow={agentId === undefined}
        select={openThread}
      />
    );
  } else if (tasks.length === 0)
    content = (
      <p className="text-ui text-muted-foreground">
        {ended ? "This run ended before it made a plan." : "The tasks appear when the run starts."}
      </p>
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
            <TaskFlow tasks={tasks} selected={task?.id} search={search} />
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-9 pt-6 pb-24 max-[1100px]:overflow-visible max-[1100px]:px-4 max-[1100px]:pt-4">
              <div className={`mx-auto ${agents ? "max-w-[80rem]" : "max-w-[55rem]"}`}>
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

function Message({ children }: { children: React.ReactNode }) {
  return <p className="px-10 py-8 text-ui text-muted-foreground">{children}</p>;
}

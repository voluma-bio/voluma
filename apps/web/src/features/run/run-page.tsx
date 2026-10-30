/**
 * The run page (`/runs/:id/live`): a header with where the run is and what is left to check, the
 * plan's tasks as a flowchart, and beside it the Overview (working on now, needs your eye,
 * results), one task (`?task=<id>`), or what the lead AI decided (`?view=decisions`).
 * Everything is derived from the run's stream (`run-model.ts`, `transcript.ts`) and `getRun`,
 * polled for what isn't an event (queue place, state, review progress).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getRun, getStudy, subscribe } from "@voluma/api-client";
import { type CheckItem, CheckPanel } from "@voluma/check-panel";
import type { Me } from "@voluma/contracts/auth";
import type { RunEvent } from "@voluma/contracts/events";
import type { Run } from "@voluma/contracts/run";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { DisclosureProvider } from "./chat/disclosure-store";
import { ThreadNavigationProvider } from "./chat/thread-navigation";
import { Corrections, correctionViews, waitingOnYou } from "./corrections";
import { Overview, useAccepting } from "./overview";
import { RunAlerts, RunHeader } from "./run-header";
import { haltOf, runView, withLiveCalls } from "./run-model";
import { TaskFlow } from "./task-flow";
import { TaskView } from "./task-view";
import { applyFrame, type Live, mainRows, noLive, type Settled, settle } from "./transcript";
import { TranscriptView } from "./transcript-view";

/**
 * The run's stream as it arrives: durable events, and live frames folded until their durable
 * event lands. Published at most once per animation frame: a busy run sends many per second.
 * `events` keeps its identity while only frames arrive, so the event derivations don't rerun
 * per token. Once the stream is over for good, live partials are dropped: nothing will complete them.
 */
function useRunStream(
  runId: string,
  onClosed: () => void,
): { events: RunEvent[]; live: Live; closed: boolean; reconnect: () => void } {
  const [state, setState] = useState<{ events: RunEvent[]; live: Live; closed: boolean }>({
    events: [],
    live: noLive,
    closed: false,
  });
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  // A message reopens an ended run: the stream opens again after the events it already has.
  const [generation, setGeneration] = useState(0);
  const kept = useRef<RunEvent[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` reopens the stream.
  useEffect(() => {
    const events = kept.current;
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
    const stop = subscribe(
      runId,
      {
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
      },
      events.at(-1)?.seq ?? 0,
    );
    return () => {
      stop();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [runId, generation]);
  const reconnect = useCallback(() => {
    setState((s) => ({ ...s, closed: false }));
    setGeneration((g) => g + 1);
  }, []);
  return { ...state, reconnect };
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
  const { events, live, closed, reconnect } = useRunStream(id, () => void run.refetch());
  const state = run.data?.state;
  // Reopened by a message (from the 3D panel) after its stream closed.
  useEffect(() => {
    if (closed && state && state.status !== "ended") reconnect();
  }, [closed, state, reconnect]);
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
    (taskId?: string, v?: "decisions") =>
      taskId ? `${base}?task=${encodeURIComponent(taskId)}` : v ? `${base}?view=${v}` : base,
    [base],
  );
  // An agent card's name in the lead AI's transcript opens its task.
  const openThread = useCallback(
    (threadId: string | null) => {
      const taskId = threadId ? threads.find((t) => t.id === threadId)?.taskId : undefined;
      navigate(search(taskId));
    },
    [threads, navigate, search],
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
  search: (taskId?: string, v?: "decisions") => string;
  openThread: (threadId: string | null) => void;
  setRun: (next: Run | ((run: Run) => Run)) => void;
  refetch: () => void;
}) {
  const accepting = useAccepting(run, setRun, refetch);
  const { tasks } = view;
  const taskId = params.get("task") ?? undefined;
  const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  const decisions = !taskId && params.get("view") === "decisions";
  const ended = run.state.status === "ended";
  const titles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const spans = useMemo(() => correctionViews(events, !ended), [events, ended]);
  const needs = tasks.flatMap((t) => t.needs);
  // An ended run's stream is closed, so a "Looks right" made here counts from `accepting.done`.
  // An ended run that takes no decisions (failed, cancelled, an example) has nothing to count.
  const toCheck =
    ended && !accepting.enabled
      ? 0
      : view.progress.toCheck -
        needs.filter((n) => n.acceptable && !n.accepted && accepting.done.has(n.id)).length;
  const [panel, setPanel] = useState<{ items: CheckItem[]; start: number }>();
  // Every "Open in 3D" walks the run's open check items, from its own (the header's: from the
  // task in view, else the first); a task with none opens alone. The panel shows "Looks right"
  // only on a run that takes decisions.
  const open3d = (taskId?: string, checkId?: string) => {
    const items = needs
      .filter((n) => n.acceptable && !n.accepted && !accepting.done.has(n.id))
      .map((n) => ({ runId: run.id, taskId: n.taskId, checkId: n.id }));
    const start = taskId
      ? items.findIndex((i) => (checkId ? i.checkId === checkId : i.taskId === taskId))
      : items.length > 0
        ? 0
        : -1;
    const alone = taskId ?? tasks[0]?.id;
    if (start !== -1) setPanel({ items, start });
    else if (alone) setPanel({ items: [{ runId: run.id, taskId: alone }], start: 0 });
  };

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
        open3d={open3d}
        search={search}
        events={events}
        live={live}
        halt={halt}
      />
    );
  else if (decisions)
    content = (
      <Decisions
        events={events}
        live={live}
        halt={halt}
        threads={threads}
        back={search()}
        lead={view.hasLead}
      />
    );
  else if (tasks.length === 0)
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
        open3d={open3d}
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
            open3d={tasks.length > 0 ? () => open3d(task?.id) : undefined}
            decisions={search(undefined, "decisions")}
            onChange={setRun}
            waiting={waitingOnYou(spans)}
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
              <div className="mx-auto max-w-[55rem]">
                <RunAlerts run={run} userId={me.userId} onChange={setRun} />
                {!task && !decisions && spans.length > 0 && (
                  <Corrections spans={spans} titleOf={(t) => titles.get(t) ?? t} search={search} />
                )}
                {content}
              </div>
            </div>
          </div>
        </main>
        {panel && (
          <CheckPanel
            items={panel.items}
            start={panel.start}
            onClose={() => setPanel(undefined)}
            onAccepted={(item) => {
              if (item.checkId) accepting.markDone(item.checkId);
              refetch();
            }}
          />
        )}
      </ThreadNavigationProvider>
    </DisclosureProvider>
  );
}

/** The lead AI's own thread: its briefs, its decisions with their reasons, plan changes. */
function Decisions({
  events,
  live,
  halt,
  threads,
  back,
  lead,
}: {
  events: RunEvent[];
  live: Live;
  halt: ReturnType<typeof haltOf>;
  threads: ReturnType<typeof withLiveCalls>;
  back: string;
  /** The run has a lead AI thread; older runs show only where each task's AI started. */
  lead: boolean;
}) {
  const rows = useMemo(() => mainRows(events, live, halt), [events, live, halt]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const leadRunning = threads.some((t) => t.kind === "main" && t.status === "running");
  return (
    <>
      <Link
        to={back}
        className="inline-flex items-center gap-1 text-ui font-medium text-primary-text hover:underline"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Overview
      </Link>
      <h2 className="mt-2 mb-4 text-xl font-semibold">What the AI decided</h2>
      {!lead && rows.length > 0 && (
        <p className="mb-4 text-ui text-muted-foreground">
          This run predates the lead AI's own record: it shows where each task's AI started.
        </p>
      )}
      <TranscriptView
        rows={rows}
        threads={threadById}
        live={leadRunning ? "" : null}
        empty="Nothing yet: the lead AI starts when the run does."
      />
    </>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="px-10 py-8 text-ui text-muted-foreground">{children}</p>;
}

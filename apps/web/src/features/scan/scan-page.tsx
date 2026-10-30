/**
 * The scan review (`/scans/:runId`): one scan's run, live or finished, in the dark shell. The main
 * area is the task in view on its grid; the left side holds To check, Report and Agents, the right
 * side View and The AI. One selection drives them all, kept in the URL: `task` (the task in view),
 * `item` (the To check item open) and `agent` (the agent whose steps show; none follows the one
 * working now). Everything is derived from the run's stream (`runView`), the run (`getRun`,
 * polled while it goes, for what isn't an event) and its review data (`getReviewRun`, for the
 * views, values and files).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { reviewRunQuery, runQuery, studyQuery, useAcceptCheck } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { ReviewRun } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import {
  DisclosureProvider,
  haltOf,
  type NeedItem,
  RunStoreProvider,
  runView,
  ThreadNavigationProvider,
  useClosed,
  useEvents,
  useRunStore,
} from "@voluma/run-view";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ShellLink,
  ShellPanel,
  useOpenPanel,
} from "@voluma/ui";
import type { StructureDisplay } from "@voluma/viewer/grid";
import { CircleAlert, Layers, LayoutDashboard, MessagesSquare, Network, Users } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentsPanel } from "./agents-panel";
import { AiPanel } from "./ai-panel";
import { ReportPanel } from "./report-panel";
import { RunAlert, ScanHeading, scanTitle } from "./scan-header";
import { ToCheckPanel } from "./to-check-panel";
import { useRunStream } from "./use-run-stream";
import { ViewPanel } from "./view-panel";

// three.js and the zarr reader load only once there is a task to show.
const TaskViewer = lazy(() => import("./viewer").then((m) => ({ default: m.TaskViewer })));

/** Keyed on the run: nothing of one run's stream, selection or decisions carries over. */
export function ScanPage() {
  const { runId = "" } = useParams();
  return (
    <RunStoreProvider key={runId}>
      <Scan runId={runId} />
    </RunStoreProvider>
  );
}

function Scan({ runId }: { runId: string }) {
  const run = useQuery({
    ...runQuery(runId),
    // Queue place and state changes aren't events; the stream is the source for the rest.
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
  });
  if (run.isPending)
    return (
      <div className="p-8">
        <LoadingState label="Loading the scan" rows={4} />
      </div>
    );
  if (!run.data) {
    const missing = run.error instanceof ApiError && run.error.status === 404;
    return (
      <div className="p-8">
        <ErrorState
          title={missing ? "This scan's run isn't here" : "Couldn't load the scan"}
          onRetry={missing ? undefined : () => void run.refetch()}
        >
          {missing ? "It may have been removed, or you can't open it. " : "Check your connection. "}
          <Link to="/" className="text-primary-text hover:underline">
            Go to Home
          </Link>
        </ErrorState>
      </div>
    );
  }
  return <ScanReview run={run.data} stale={run.isError} refetchRun={() => void run.refetch()} />;
}

/**
 * The review payload: polled while the run has no plan (409) or goes, and for ten minutes after
 * it ends while its images are still being converted; one last fetch when the run ends, since
 * the payload carries no run state.
 */
function useReviewRun(runId: string, run: Run) {
  const client = useQueryClient();
  const status = run.state.status;
  const endedAt = run.state.status === "ended" ? Date.parse(run.state.endedAt) : undefined;
  const last = useRef(status);
  useEffect(() => {
    if (last.current !== "ended" && status === "ended")
      void client.invalidateQueries({ queryKey: reviewRunQuery(runId).queryKey });
    last.current = status;
  }, [status, runId, client]);
  return useQuery({
    ...reviewRunQuery(runId),
    // Only a server error may pass on retry; a 404, a 409 or data the contract rejects won't.
    retry: (count, cause) => cause instanceof ApiError && cause.status >= 500 && count < 2,
    refetchInterval: (query) => {
      const cause = query.state.error;
      const data = query.state.data;
      return (cause instanceof ApiError && cause.status === 409) ||
        status !== "ended" ||
        (data && preparing(data) && endedAt !== undefined && Date.now() - endedAt < 10 * 60_000)
        ? 5000
        : false;
    },
  });
}

/** Whether a file the latest results draw is still being converted for viewing (no entry yet). */
function preparing(run: ReviewRun): boolean {
  const latest = run.revisions.at(-1);
  if (!latest) return false;
  const files = [
    ...latest.volumes.flatMap((v) => (v.data?.format === "npy" ? [v.data.sha256] : [])),
    ...latest.structures.flatMap((s) =>
      s.voxels && "mask" in s.voxels ? [s.voxels.mask.sha256] : [],
    ),
    ...latest.surfaces.map((s) => s.heights.sha256),
  ];
  return files.some((sha256) => !run.assets[sha256]);
}

/** "Looks right" on a completed run's latest result; an example takes no decisions. */
function useAccepting(run: Run) {
  const queryClient = useQueryClient();
  // Accepted here: an ended run's stream is closed, so the decision never comes back on it.
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<{ id: string; text: string }>();
  const mutation = useAcceptCheck(run.id, run.review?.revisionId, {
    onMutate: ({ checkId }) => setError((e) => (e?.id === checkId ? undefined : e)),
    onSuccess: (res, { checkId }) => {
      setDone((d) => new Set(d).add(checkId));
      queryClient.setQueryData<Run>(runQuery(run.id).queryKey, (r) =>
        r ? { ...r, review: res.review } : r,
      );
    },
    onSettled: (_res, e, { checkId }) => {
      if (e) setError({ id: checkId, text: e.message });
    },
  });
  const readOnly = run.example
    ? "Example runs can't be changed."
    : run.state.status !== "ended"
      ? "You can decide once the run finishes."
      : run.review === null
        ? "This run didn't finish, so there is nothing to accept."
        : undefined;
  return {
    readOnly,
    accept: readOnly
      ? undefined
      : (item: NeedItem) => mutation.mutate({ checkId: item.id, taskId: item.taskId }),
    pending: mutation.isPending ? mutation.variables?.checkId : undefined,
    done,
    error,
  };
}
export type Accepting = ReturnType<typeof useAccepting>;

function ScanReview({
  run,
  stale,
  refetchRun,
}: {
  run: Run;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  refetchRun: () => void;
}) {
  const me = useOutletContext<Me>();
  const navigate = useNavigate();
  const openPanel = useOpenPanel();
  const study = useQuery({
    ...studyQuery(run.studyId),
    // Labels only (the study's name, the scan's subject, knee and group): read once.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const store = useRunStore();
  const [generation, setGeneration] = useState(0);
  useRunStream(run.id, generation, refetchRun);
  const events = useEvents();
  const closed = useClosed();
  // Query's structural sharing keeps `state` the same object across polls that change nothing.
  const { state, providerCalls } = run;
  const halt = useMemo(() => haltOf(state, closed), [state, closed]);
  const view = useMemo(
    () => runView(events, state, providerCalls, halt),
    [events, state, providerCalls, halt],
  );
  // Layout effect: the agent views read these from the store and must not paint without them.
  useLayoutEffect(
    () => store.set({ halt, baseThreads: view.threads }),
    [store, halt, view.threads],
  );
  const review = useReviewRun(run.id, run);
  const accepting = useAccepting(run);

  const [params, setParams] = useSearchParams();
  const select = useCallback(
    (patch: { task?: string | null; item?: string | null; agent?: string | null }) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch))
            if (v === null) next.delete(k);
            else if (v !== undefined) next.set(k, v);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const { tasks } = view;
  const items = useMemo(
    () =>
      tasks.flatMap((t) =>
        t.needs.map((n) => (accepting.done.has(n.id) ? { ...n, accepted: true } : n)),
      ),
    [tasks, accepting.done],
  );
  const itemId = params.get("item") ?? undefined;
  const firstOpen = items.find((n) => !n.accepted);
  const item = items.find((n) => n.id === itemId) ?? firstOpen ?? items[0];
  const taskId = params.get("task") ?? item?.taskId ?? tasks[0]?.id;
  const task = tasks.find((t) => t.id === taskId);
  const agentId = params.get("agent") ?? undefined;

  const latest = review.data?.revisions.at(-1);
  const reviewTask = latest?.tasks.find((t) => t.id === taskId) ?? latest?.tasks[0];
  // The open item moves the crosshair, once per pick: a new object each time it is picked.
  const [picked, setPicked] = useState(0);
  const check =
    item && item.taskId === reviewTask?.id
      ? reviewTask.checks.find((c) => c.id === item.id)
      : undefined;
  const focusKey = check?.focus && JSON.stringify(check.focus);
  const focus = useMemo(() => check?.focus && { ...check.focus }, [focusKey, picked]);
  const [display, setDisplay] = useState<StructureDisplay>({});

  const pickItem = (next: NeedItem) => {
    select({ item: next.id, task: next.taskId });
    setPicked((n) => n + 1);
  };
  const openAgent = useCallback(
    (threadId: string | null) => {
      select({ agent: threadId });
      openPanel("scan-agents");
    },
    [select, openPanel],
  );
  // Something's wrong: the AI panel opens on the item's task, the composer ready.
  const [about, setAbout] = useState<{ taskId: string; at: number }>();
  const tellAi = (taskOf: string) => {
    setAbout({ taskId: taskOf, at: Date.now() });
    openPanel("scan-ai");
  };

  const open = items.filter((n) => !n.accepted).length;
  const { title } = scanTitle(run, study.data);
  const studyId = study.data?.study.id;

  let main: React.ReactNode;
  if (!review.data) {
    const status = review.error instanceof ApiError ? review.error.status : undefined;
    main =
      review.isPending || status === 409 ? (
        <Centered>
          {review.isPending ? (
            <LoadingState label="Loading the views" rows={3} className="w-72" />
          ) : (
            <EmptyState title="No views yet">
              The views appear once the AI has planned its tasks.
            </EmptyState>
          )}
        </Centered>
      ) : (
        <Centered>
          <ErrorState title="Couldn't load the views" onRetry={() => void review.refetch()}>
            Check your connection, then try again.
          </ErrorState>
        </Centered>
      );
  } else if (!latest || !reviewTask)
    main = (
      <Centered>
        <EmptyState title="No views yet">
          The views appear with the first task's results.
        </EmptyState>
      </Centered>
    );
  else
    main = (
      <Suspense
        fallback={
          <Centered>
            <LoadingState label="Loading the viewer" rows={3} className="w-72" />
          </Centered>
        }
      >
        <TaskViewer
          runId={run.id}
          revision={latest}
          task={reviewTask}
          assets={review.data.assets}
          display={display}
          focus={focus}
        />
      </Suspense>
    );

  return (
    <DisclosureProvider>
      <ThreadNavigationProvider onOpenThread={openAgent}>
        <ScanHeading run={run} study={study.data} progress={view.progress} />
        <ShellLink
          id="scan-study"
          group="study"
          label="Study"
          icon={<LayoutDashboard />}
          active={false}
          go={() => studyId && navigate(`/studies/${studyId}`)}
        />
        <ShellPanel
          id="scan-to-check"
          side="left"
          group="scan"
          label="To check"
          icon={<CircleAlert />}
          count={open}
          shortcut="t"
          defaultOpen
          tools={<span className="font-mono text-xs text-muted-foreground">{title}</span>}
        >
          <ToCheckPanel
            runId={run.id}
            scan={title}
            items={items}
            tasks={tasks}
            current={item}
            onPick={pickItem}
            accepting={accepting}
            onWrong={(n) => tellAi(n.taskId)}
            live={run.state.status !== "ended"}
          />
        </ShellPanel>
        <ShellPanel
          id="scan-report"
          side="left"
          group="scan"
          label="Report"
          icon={<Network />}
          shortcut="r"
        >
          <ReportPanel
            runId={run.id}
            tasks={tasks}
            task={task}
            reviewTask={reviewTask?.id === task?.id ? reviewTask : undefined}
            onTask={(id) => select({ task: id, item: null })}
            onItem={(n) => {
              pickItem(n);
              openPanel("scan-to-check");
            }}
            onAgent={openAgent}
            items={items}
          />
        </ShellPanel>
        <ShellPanel
          id="scan-agents"
          side="left"
          group="scan"
          label="Agents"
          icon={<Users />}
          shortcut="a"
          minWidth={360}
        >
          <AgentsPanel
            agentId={agentId}
            onAgent={(id) => select({ agent: id })}
            ended={run.state.status === "ended"}
          />
        </ShellPanel>
        <ShellPanel id="scan-view" side="right" label="View" icon={<Layers />} shortcut="v">
          <ViewPanel revision={latest} task={reviewTask} display={display} onDisplay={setDisplay} />
        </ShellPanel>
        <ShellPanel
          id="scan-ai"
          side="right"
          label="The AI"
          icon={<MessagesSquare />}
          shortcut="i"
          defaultOpen
        >
          <AiPanel
            run={run}
            me={me}
            scan={title}
            tasks={tasks}
            task={task}
            about={about}
            onSent={() => {
              setGeneration((g) => g + 1);
              refetchRun();
            }}
          />
        </ShellPanel>
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          <RunAlert run={run} userId={me.userId} stale={stale} />
          <div className="min-h-0 flex-1">{main}</div>
        </div>
      </ThreadNavigationProvider>
    </DisclosureProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

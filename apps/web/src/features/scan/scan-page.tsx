/**
 * The scan review (`/scans/:runId`): one scan's run, live or finished, in the light shell. The main
 * area is the task in view on its grid; the left side holds Study, To check, Report and Agents, the
 * right side View, Marks and The AI. One selection drives them all, kept in the URL: `task` (the task in view),
 * `item` (the To check item open) and `agent` (the agent whose steps show; none follows the one
 * working now). Everything is derived from the run's stream (`runView`), the run (`getRun`,
 * polled while it goes, for what isn't an event) and its review data (`getReviewRun`, for the
 * views, values, files and human decisions). Your marks are page state, until a message to the
 * AI carries them.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { reviewRunQuery, runQuery, studyQuery, useAcceptCheck } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { MAX_MARKS } from "@voluma/contracts/messages";
import type { ReviewRun, Revision } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import {
  DisclosureProvider,
  haltOf,
  isLive,
  type NeedItem,
  plural,
  RunStoreProvider,
  runHref,
  runView,
  StudyPanel,
  ThreadNavigationProvider,
  useClosed,
  useEvents,
  useRunStore,
} from "@voluma/run-view";
import { Button, EmptyState, ErrorState, LoadingState, ShellPanel, useOpenPanel } from "@voluma/ui";
import type {
  GridMark,
  GridViewerHandle,
  MarkTool,
  StructureDisplay,
  Zyx,
} from "@voluma/viewer/grid";
import { workflowById } from "@voluma/workflow/bundled";
import {
  ArrowUpRight,
  CircleAlert,
  Layers,
  ListChecks,
  MessagesSquare,
  Network,
  PanelLeft,
  Users,
} from "lucide-react";
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
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { AgentsPanel } from "./agents-panel";
import { AiPanel, useMessage } from "./ai-panel";
import {
  gridMark,
  MarksPanel,
  middleOf,
  nextTag,
  type ShownGrid,
  TOOLS,
  type YourMark,
} from "./marks-panel";
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
    // Queue place and state changes aren't events; the stream is the source for the rest. Also in
    // a background tab: a run waiting for keys gets them from this page (`RunAlert`).
    refetchInterval: (q) => (q.state.data?.state.status === "ended" ? false : 3000),
    refetchIntervalInBackground: true,
  });
  // Laid out as the study page's own loading and not-found states.
  const page = "mx-auto w-full max-w-2xl px-6 py-8";
  if (run.isPending)
    return (
      <div className={page}>
        <LoadingState label="Loading the scan" rows={4} />
      </div>
    );
  if (!run.data) {
    const missing = run.error instanceof ApiError && run.error.status === 404;
    return (
      <div className={page}>
        <ErrorState
          title={missing ? "This scan isn't here" : "Couldn't load the scan"}
          onRetry={missing ? undefined : () => void run.refetch()}
        >
          {missing
            ? "It may have been removed, or it belongs to another lab."
            : "Check your connection, then try again."}{" "}
          <Button asChild variant="link">
            <Link to="/">Go to Home</Link>
          </Button>
        </ErrorState>
      </div>
    );
  }
  return <ScanReview run={run.data} stale={run.isError} refetchRun={() => void run.refetch()} />;
}

/**
 * The review payload, fetched again when the stream shows a task's state or results changing
 * (`changed`) and when the run ends, since the payload carries no run state. Polled only while
 * the run has no plan (409) and while its images are still being converted (until ten minutes
 * after it ends): neither shows on the stream.
 */
function useReviewRun(runId: string, run: Run, changed: string) {
  const client = useQueryClient();
  const status = run.state.status;
  const endedAt = run.state.status === "ended" ? Date.parse(run.state.endedAt) : undefined;
  const last = useRef({ status, changed });
  const due = useRef(false);
  useEffect(() => {
    const before = last.current;
    last.current = { status, changed };
    if ((before.status !== "ended" && status === "ended") || before.changed !== changed)
      due.current = true;
    if (!due.current) return;
    // Once things settle: a stream's backlog changes `changed` on every frame while it loads.
    const timer = setTimeout(() => {
      due.current = false;
      void client.invalidateQueries({ queryKey: reviewRunQuery(runId).queryKey });
    }, 1000);
    return () => clearTimeout(timer);
  }, [status, changed, runId, client]);
  return useQuery({
    ...reviewRunQuery(runId),
    // Execution SSE ends before later human decisions. Reconcile on return, even when ended.
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    // Only a server error may pass on retry; a 404, a 409 or data the contract rejects won't.
    retry: (count, cause) => cause instanceof ApiError && cause.status >= 500 && count < 2,
    refetchInterval: (query) => {
      const cause = query.state.error;
      const data = query.state.data;
      return (cause instanceof ApiError && cause.status === 409) ||
        (data && preparing(data) && (endedAt === undefined || Date.now() - endedAt < 10 * 60_000))
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
function useAccepting(run: Run, revision: Revision | undefined) {
  const [error, setError] = useState<{ id: string; text: string }>();
  const mutation = useAcceptCheck(run.id, revision?.id, {
    onMutate: ({ checkId }) => setError((e) => (e?.id === checkId ? undefined : e)),
    // `useAcceptCheck` already words the failure (read-only, changed since, couldn't save).
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
        : !revision
          ? "Wait for the results to load."
          : undefined;
  return {
    readOnly,
    accept: readOnly
      ? undefined
      : (item: NeedItem, onAccepted?: () => void) => {
          const task = revision?.tasks.find((t) => t.id === item.taskId);
          if (
            task?.resultRevisionId !== item.resultRevisionId ||
            !task.checks.some((c) => c.id === item.id)
          ) {
            setError({ id: item.id, text: "This changed since you opened it. Look again." });
            return;
          }
          mutation.mutate(
            { checkId: item.id, taskId: item.taskId, resultRevisionId: item.resultRevisionId },
            { onSuccess: onAccepted },
          );
        },
    pending: mutation.isPending ? mutation.variables?.checkId : undefined,
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
  const openPanel = useOpenPanel();
  const study = useQuery({
    ...studyQuery(run.studyId),
    refetchInterval: (query) =>
      isLive(run) || query.state.data?.scans.some((scan) => isLive(scan.runs[0])) ? 5000 : false,
  });
  const store = useRunStore();
  const [reopened, setReopened] = useState(0);
  useRunStream(run.id, {
    reopened,
    revisionId: run.review?.revisionId,
    going: run.state.status !== "ended",
    onClosed: refetchRun,
  });
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
  // What the review payload follows: per task its state, its tries (a redo opens one, even when it
  // lands in one batch with its result) and its values.
  const changed = useMemo(
    () =>
      view.tasks
        .map((t) => {
          const tries = t.threads.reduce((n, th) => n + th.attempts.length, t.threads.length);
          return `${t.id}:${t.state}:${tries}:${t.results.map((r) => r.value).join("|")}`;
        })
        .join(),
    [view.tasks],
  );
  const review = useReviewRun(run.id, run, changed);
  const latest = review.data?.revisions.at(-1);
  const accepting = useAccepting(run, latest);

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
      tasks.flatMap((t) => {
        const result = latest?.tasks.find((r) => r.id === t.id);
        return t.needs.map((n) => {
          if (result?.resultRevisionId !== n.resultRevisionId) return n;
          const check = result.checks.find((c) => c.id === n.id);
          return check ? { ...n, accepted: check.status === "accepted" } : n;
        });
      }),
    [tasks, latest],
  );
  // `item` (a check id) names its own task; without it the task in view comes from `task`, else
  // the first open item's. The open item is always one of the task in view: its first open one
  // when the URL names none, so the card and the views can't disagree.
  const named = items.find((n) => n.id === params.get("item"));
  const taskId =
    named?.taskId ?? params.get("task") ?? items.find((n) => !n.accepted)?.taskId ?? tasks[0]?.id;
  const ofTask = items.filter((n) => n.taskId === taskId);
  const item = named ?? ofTask.find((n) => !n.accepted) ?? ofTask[0];
  const task = tasks.find((t) => t.id === taskId);
  // A link whose `task` disagrees with its `item` is put right, so the URL says what is shown.
  const wrongTask = named !== undefined && params.get("task") !== named.taskId;
  useEffect(() => {
    if (wrongTask && named) select({ task: named.taskId });
  }, [wrongTask, named, select]);
  const agentId = params.get("agent") ?? undefined;

  const reviewTask = latest?.tasks.find((t) => t.id === taskId);
  // The open item moves the crosshair, once per pick: a new object each time it is picked.
  const [picked, setPicked] = useState(0);
  const check =
    item && item.taskId === reviewTask?.id
      ? reviewTask.checks.find((c) => c.id === item.id)
      : undefined;
  const focusKey = check?.focus && JSON.stringify(check.focus);
  const focus = useMemo(() => check?.focus && { ...check.focus }, [focusKey, picked]);
  const [display, setDisplay] = useState<StructureDisplay>({});
  const marking = useMarking();

  const pickItem = (next: NeedItem) => {
    select({ item: next.id, task: next.taskId });
    setPicked((n) => n + 1);
    marking.jumped();
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
  // It holds until the reader moves to another task or the message is sent.
  useEffect(() => setAbout(undefined), [taskId]);
  // What a message about its subject carries: the views and your marks on them, when the views
  // shown are the subject's.
  const subjectShown =
    marking.shown?.taskId === (about?.taskId ?? taskId) ? marking.shown : undefined;
  const sendable = useMemo(
    () => (subjectShown ? marking.marks.filter((m) => m.gridKey === subjectShown.key) : []),
    [marking.marks, subjectShown],
  );
  const snapshot = subjectShown ? marking.snapshot : undefined;
  const message = useMessage({
    run,
    me,
    tasks,
    task,
    about,
    marks: sendable,
    snapshot,
    viewKey: subjectShown?.key,
    itemId: item?.taskId === (about?.taskId ?? taskId) ? item?.id : undefined,
    onSent: (sent) => {
      setAbout(undefined);
      marking.drop(sent);
      setReopened((n) => n + 1);
      refetchRun();
    },
  });

  const open = items.filter((n) => !n.accepted).length;
  const { title } = scanTitle(run, study.data);

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
        <EmptyState title={task ? `No views for ${task.title} yet` : "No views yet"}>
          The views appear with this task's results.
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
          tool={marking.tool}
          onTool={marking.setTool}
          marks={marking.marks}
          selected={marking.selected}
          jump={marking.jump}
          onJumped={marking.jumped}
          onMark={(mark, volumeId, gridKey) => marking.add(mark, volumeId, gridKey, reviewTask.id)}
          onShown={marking.setShown}
          viewer={marking.viewer}
        />
      </Suspense>
    );

  return (
    <DisclosureProvider>
      <ThreadNavigationProvider onOpenThread={openAgent}>
        <ScanHeading run={run} study={study.data} progress={view.progress} />
        <ShellPanel
          id="scan-study"
          side="left"
          group="study"
          label="Study"
          icon={<PanelLeft />}
          shortcut="s"
        >
          {study.data ? (
            <>
              {study.isError && (
                <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
                  Couldn't refresh the study; what you see may be out of date.
                  <Button variant="link" onClick={() => void study.refetch()}>
                    Try again
                  </Button>
                </p>
              )}
              {study.data.scans.length > 1 && (
                <div className="border-b border-border px-4 py-2">
                  <Button asChild variant="link">
                    <Link to={`/studies/${study.data.study.id}`}>
                      Study overview <ArrowUpRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              )}
              <StudyPanel
                detail={study.data}
                about={`${plural(study.data.scans.length, "scan")}, ${workflowById(study.data.study.workflowId)?.name ?? study.data.study.workflowId}`}
                current={run.input.id}
                scanLink={({ runs: [latestRun] }) =>
                  latestRun
                    ? (props) => (
                        <Link
                          to={
                            latestRun.id === run.id
                              ? { search: params.toString() }
                              : runHref({ runId: latestRun.id })
                          }
                          {...props}
                        />
                      )
                    : undefined
                }
              />
            </>
          ) : study.isPending ? (
            <LoadingState label="Loading the study" rows={3} className="p-4" />
          ) : (
            <div className="p-4">
              <ErrorState title="Couldn't load the study" onRetry={() => void study.refetch()}>
                Check your connection, then try again.
              </ErrorState>
            </div>
          )}
        </ShellPanel>
        <ShellPanel
          id="scan-to-check"
          side="left"
          group="scan"
          label="To check"
          icon={<CircleAlert />}
          count={open}
          shortcut="t"
          defaultOpen
          tools={<span className="text-xs text-muted-foreground">{title}</span>}
        >
          <ToCheckPanel
            runId={run.id}
            scan={title}
            items={items}
            tasks={tasks}
            current={item}
            inView={task?.title}
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
            tasks={tasks}
            agentId={agentId}
            onAgent={(id) => select({ agent: id })}
            ended={run.state.status === "ended"}
          />
        </ShellPanel>
        <ShellPanel id="scan-view" side="right" label="View" icon={<Layers />} shortcut="v">
          <ViewPanel revision={latest} task={reviewTask} display={display} onDisplay={setDisplay} />
        </ShellPanel>
        <ShellPanel
          id="scan-marks"
          side="right"
          label="Marks"
          icon={<ListChecks />}
          count={marking.marks.length || undefined}
          shortcut="m"
        >
          <MarksPanel
            marks={marking.marks}
            shown={marking.shown}
            taskTitle={(id) => tasks.find((t) => t.id === id)?.title ?? id}
            selected={marking.selected}
            onSelect={(id) => {
              const mark = marking.select(id);
              // A mark on another grid opens the task it was made on; the views go to it there.
              if (mark && mark.gridKey !== marking.shown?.key)
                select({ task: mark.taskId, item: null });
            }}
            onDelete={marking.remove}
          />
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
            scan={title}
            tasks={tasks}
            about={about}
            marks={sendable}
            views={snapshot !== undefined}
            message={message}
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

/**
 * Your marks and the tool that makes them. A tool's key (`TOOLS`) picks it and Esc puts it away,
 * as the shell's panel keys do: never while typing, never with a modifier. Listening on the
 * document puts this after a pane's own Esc (dropping a mark being drawn) and before the shell's
 * (leaving Full view), so one Esc does one thing.
 */
function useMarking() {
  const [tool, setTool] = useState<MarkTool | null>(null);
  const [marks, setMarks] = useState<YourMark[]>([]);
  const [selected, setSelected] = useState<string>();
  const [jump, setJump] = useState<{ at: Zyx; gridKey: string; taskId: string }>();
  const [shown, setShown] = useState<ShownGrid>();
  const viewer = useRef<GridViewerHandle>(null);
  const full = marks.length >= MAX_MARKS;
  const latest = useRef({ tool, full });
  latest.current = { tool, full };
  // At the cap the tools are held off (`viewer.tsx` says why).
  useEffect(() => {
    if (full) setTool(null);
  }, [full]);
  useEffect(() => {
    const keys = new Map(
      TOOLS.map((t) => [t.shortcut.toLowerCase(), t.value === "navigate" ? null : t.value]),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [role='dialog'], [role='menu']")
      )
        return;
      const next = keys.get(event.key.toLowerCase());
      if (next === undefined) return;
      // Esc with no tool out is the shell's; a tool's key at the cap does nothing.
      if (next === null ? !latest.current.tool : latest.current.full) return;
      event.preventDefault();
      setTool(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return {
    tool,
    setTool,
    marks,
    selected,
    jump,
    shown,
    setShown,
    viewer,
    jumped: useCallback(() => setJump(undefined), []),
    add: useCallback((mark: GridMark, volumeId: string, gridKey: string, taskId: string) => {
      setMarks((had) =>
        had.length >= MAX_MARKS
          ? had
          : [
              ...had,
              {
                id: crypto.randomUUID(),
                tag: nextTag(had, mark),
                taskId,
                gridKey,
                mark: { volumeId, ...mark },
              },
            ],
      );
    }, []),
    /** Selects a mark and aims the views at it; returns it. */
    select: useCallback(
      (id: string) => {
        setSelected(id);
        const mark = marks.find((m) => m.id === id);
        const shape = mark && gridMark(mark.mark);
        if (mark && shape)
          setJump({ at: middleOf(shape), gridKey: mark.gridKey, taskId: mark.taskId });
        return mark;
      },
      [marks],
    ),
    remove: useCallback((id: string) => setMarks((had) => had.filter((m) => m.id !== id)), []),
    /** Drops the marks a message carried. */
    drop: useCallback((ids: string[]) => {
      if (ids.length) setMarks((had) => had.filter((m) => !ids.includes(m.id)));
    }, []),
    snapshot: useCallback(
      // Undefined until the lazy viewer mounts: nothing to picture yet.
      (maxBytes: number) => viewer.current?.snapshot(maxBytes) ?? Promise.resolve(undefined),
      [],
    ),
  };
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

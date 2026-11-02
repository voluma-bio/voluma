/**
 * The scan review of a run of the agent loop (Q24, mockup C), in the shell's two side panels. The
 * left side's tabs: the conversation with the run's main AI (the default; read-only until
 * researchers can write to it on this kind of run, badged while main waits on an approval) and
 * the scans (the shared tree, named by `INPUT_WORD`). In the centre the output in view on four panes (`QuadViewer`) with
 * the tool bar docked under them, or a file output, the whole run's graph (W) or the run's agents
 * in the panes' place. On the right, Final outputs: the picked value opens in place with what it
 * rests on. Everything comes from the run's stream as it arrives: the output fold
 * (`outputsFold`), its converted assets and the conversation, so statuses and values update live.
 *
 * The URL keeps `output` (the value picked in Final outputs), `trail` (an output it rests on,
 * near or further back, whose report is open and which the panes show), `item` (the To check
 * item whose place the panes show) and `centre` (`run` for the whole run, `agents`). An `output`
 * that is not a final value opens under the first final value resting on it. The panes' layout
 * is page state: it holds while another output, on another grid, is shown.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, acceptToCheck, saveView } from "@voluma/api-client";
import { studiesQuery, studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { conversation } from "@voluma/contracts/conversation";
import type { RunEvent } from "@voluma/contracts/events";
import { outputsFold } from "@voluma/contracts/output-fold";
import type { RunRead } from "@voluma/contracts/run";
import {
  isLive,
  Markdown,
  type OutputItem,
  type OutputRow,
  outputBlocks,
  outputName,
  outputsReview,
  reviewAssetsOf,
  sampleTree,
  shownOf,
  trailOf,
  undrawn,
  useEvents,
} from "@voluma/run-view";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  INPUT_WORD,
  LoadingState,
  Menu,
  MenuItem,
  SampleTree,
  SidePanel,
  StatusMark,
  useFoldWhile,
  useFullView,
} from "@voluma/ui";
import {
  type GridPlanes,
  type PlaneFit,
  QUAD_START,
  type QuadLayout,
  type QuadState,
  readView,
  storedWords,
  storeView,
} from "@voluma/viewer/grid";
import { outputCatalogOf } from "@voluma/workflow/output-catalogs";
import {
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ListTree,
  MessageSquare,
  Sigma,
  Workflow,
  X,
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
import { Link, useOutletContext, useSearchParams } from "react-router";
import { FileOutput } from "./file-output";
import { describe, QUAD_TOOLS, useLocalMarks, useMarking } from "./marks-panel";
import { FinalOutputs, needingYou, OUTPUT_STATUS } from "./outputs-panel";
import { RunAgents } from "./run-agents";
import { RunGraphView } from "./run-graph";
import { useRunMarks } from "./run-marks";
import { RunAlert, ScanHeading } from "./scan-header";
import type { Accepting } from "./version-report";

// three.js and the zarr reader load only once there is an output to show.
const SceneViewer = lazy(() => import("./viewer").then((m) => ({ default: m.SceneViewer })));

type Centre = "run" | "agents";

export function OutputsReview({
  run,
  stale,
  reopen,
}: {
  run: RunRead;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  /** Reconnects the run's stream, to catch what a write of yours added to the log. */
  reopen: () => void;
}) {
  const me = useOutletContext<Me>();
  const study = useQuery({
    ...studyQuery(run.studyId),
    refetchInterval: (query) =>
      isLive(run) || query.state.data?.scans.some((scan) => isLive(scan.runs[0])) ? 5000 : false,
  });
  const events = useEvents();
  const catalog = useMemo(() => outputCatalogOf(run.workflows[0]?.path), [run.workflows]);
  const fold = outputsFold(events);
  const review = useMemo(() => outputsReview(fold, catalog), [fold, catalog]);
  const assets = useMemo(() => reviewAssetsOf(events), [events]);
  const blocks = useMemo(
    () => outputBlocks(fold, catalog, run.id, assets),
    [fold, catalog, run.id, assets],
  );
  const nameOf = useCallback((id: string) => outputName(catalog, id), [catalog]);
  const planesOf = useCallback(
    (imageId: string): GridPlanes | undefined => {
      const entry = catalog.find((e) => e.id === imageId);
      return entry?.kind === "base" ? entry.planes : undefined;
    },
    [catalog],
  );

  // Planes the catalog fits through surfaces (the growth plate's faces), by code.
  const fits = useMemo(() => {
    const byCode = new Map<string, PlaneFit>();
    for (const e of catalog)
      if (e.kind === "overlay" && e.fitsPlane) {
        const had = byCode.get(e.fitsPlane.code);
        byCode.set(e.fitsPlane.code, {
          code: e.fitsPlane.code,
          name: e.fitsPlane.name,
          surfaces: [...(had?.surfaces ?? []), e.id],
        });
      }
    return [...byCode.values()];
  }, [catalog]);

  const [params, setParams] = useSearchParams();
  const select = useCallback(
    (patch: {
      output?: string;
      item?: string | null;
      trail?: string | null;
      centre?: Centre | null;
    }) =>
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
  // The value open in place: the URL's, else the first final output with an open item, else the
  // first. An output that is not in the list opens under the first value resting on it.
  const finals = review.sections.flatMap((s) => s.rows);
  const listed = [...finals, ...review.undeclared];
  const restingOn = useCallback(
    (id: string) => listed.find((r) => trailOf(fold, r.id).some((t) => t.id === id)),
    [listed, fold],
  );
  const asked = params.get("output") ?? "";
  const askedRow = listed.find((r) => r.id === asked);
  const under = !askedRow && asked ? restingOn(asked) : undefined;
  const selected =
    askedRow ??
    under ??
    finals.find((r) => r.items.some((i) => !i.resolved)) ??
    finals[0] ??
    review.undeclared[0];
  const opened = review.rows.get(params.get("trail") ?? (under ? asked : ""));
  const trailOpen = opened && opened.id !== selected?.id ? opened : undefined;
  // Picking any output: a listed value opens in place; anything else under the value resting on it.
  const show = useCallback(
    (id: string) => {
      if (listed.some((r) => r.id === id)) select({ output: id, trail: null, item: null });
      else {
        const value = restingOn(id);
        select({ output: value?.id ?? id, trail: id, item: null });
      }
    },
    [listed, restingOn, select],
  );
  const inView = trailOpen ?? selected;
  const centreParam = params.get("centre");
  const centre: Centre | undefined =
    centreParam === "run" || centreParam === "agents" ? centreParam : undefined;
  const item = selected?.items.find((i) => i.key === params.get("item"));
  // Show moves the crosshair once per press: a new object each time.
  const [picked, setPicked] = useState(0);
  const focusKey = item?.focus && JSON.stringify(item.focus);
  const focus = useMemo(() => item?.focus && { ...item.focus }, [focusKey, picked]);

  const accepting = useAcceptToCheck(run, reopen);
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const needing = needingYou(review).size;
  const [leftTab, setLeftTab] = useState("conversation");
  const waiting = useMemo(() => waitingApprovals(events), [events]);
  const live = run.state.status !== "ended";
  const runMarks = useRunMarks({
    run,
    me: me.userId,
    events,
    volumes: blocks.volumes,
    reopen,
  });
  // An example run keeps no marks (its writes are refused): they are the page's, uncapped.
  const exampleMarks = useLocalMarks();
  const marking = useMarking(QUAD_TOOLS, run.example ? exampleMarks : runMarks);
  const views = useSavedViews(run, reopen);

  // A pane fills the centre in the shell's Full view: filling one folds the side panels, and
  // leaving Full view (Esc, F, opening a panel) puts the panes back. The page keeps only which
  // view fills; whether it shows is the shell's.
  const [shellFull, setShellFull] = useFullView();
  const [arranged, setArranged] = useState<QuadLayout>(QUAD_START);
  const [fill, setFill] = useState<QuadLayout["full"]>(null);
  // Forgotten once Full view is left, so F later folds the sides without filling a pane.
  if (!shellFull && fill) setFill(null);
  const layout = useMemo(
    () => ({ ...arranged, full: shellFull ? fill : null }),
    [arranged, shellFull, fill],
  );
  const onLayout = useCallback(
    (next: QuadLayout) => {
      setArranged(next);
      setFill(next.full);
      if (!!next.full !== !!keys.current.layout.full) setShellFull(!!next.full);
    },
    [setShellFull],
  );
  // The whole run folds Final outputs to its strip while it is up, so the graph gets the width;
  // unfolding the strip during it leaves the whole run.
  useFoldWhile(
    "right",
    centre === "run",
    useCallback(() => select({ centre: null }), [select]),
  );
  const toggleRun = useCallback(
    () => select({ centre: keys.current.centre === "run" ? null : "run" }),
    [select],
  );
  const keys = useRef({ layout, centre, trailOpen, shellFull });
  keys.current = { layout, centre, trailOpen, shellFull };
  // W: the whole run and back. Esc, once a mark and the tool are put away (`useMarking`, on the
  // document, first) and Full view is left (the shell's): the whole run or the agents, then an
  // open trail item.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [role='dialog'], [role='menu']")
      )
        return;
      const k = keys.current;
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        toggleRun();
      } else if (event.key === "Escape" && !k.shellFull) {
        if (k.centre) select({ centre: null });
        else if (k.trailOpen) select({ trail: null, item: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, toggleRun]);

  let panes: React.ReactNode;
  if (!inView)
    panes = (
      <Centered>
        <EmptyState title="No outputs yet">
          {live ? "The outputs appear once the AI has set them up." : undefined}
        </EmptyState>
      </Centered>
    );
  else if (!inView.state.latest)
    panes = (
      <Centered>
        <EmptyState
          title={
            inView.state.status === "missing"
              ? `${inView.name} is missing`
              : `${inView.name} isn't reported yet`
          }
        >
          {inView.state.missingReason ??
            (live ? "It shows here once the AI reports it." : "The run ended without it.")}
        </EmptyState>
      </Centered>
    );
  else if (inView.state.kind === "file")
    panes = <FileOutput runId={run.id} version={inView.state.latest} />;
  else if (inView.state.kind === "collection")
    panes = (
      <Centered>
        <EmptyState title={`${inView.name} is a list`}>
          Lists open here as a table in a later version.
        </EmptyState>
      </Centered>
    );
  else
    panes = (
      <OutputScene
        runId={run.id}
        blocks={blocks}
        assets={assets}
        subject={inView.id}
        shown={shownOf(inView)}
        nameOf={nameOf}
        focus={trailOpen ? undefined : focus}
        marking={marking}
        quad={{
          layout,
          onLayout,
          planesOf,
          fits,
          onNote: marking.note,
          onSave: views.save && ((state, grid) => views.save!(inView, state, grid)),
          restore: views.restore,
        }}
      />
    );

  return (
    <>
      <ScanHeading
        run={run}
        study={study.data}
        progress={{ ...review.progress, noun: "outputs reported" }}
      />
      <div className="flex min-h-0 flex-1">
        <SidePanel
          side="left"
          tab={leftTab}
          onTabChange={setLeftTab}
          tabs={[
            {
              id: "conversation",
              label: "Conversation",
              icon: <MessageSquare />,
              badge: waiting || undefined,
              badgeLabel: "main is waiting on you",
              content: (
                <MainConversation
                  live={live}
                  nameOf={nameOf}
                  marking={marking}
                  markError={runMarks.error}
                />
              ),
            },
            {
              id: "samples",
              label: INPUT_WORD.Many,
              icon: <ListTree />,
              content: <Samples studyId={run.studyId} runId={run.id} />,
            },
          ]}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <RunAlert run={run} userId={me.userId} stale={stale} />
          <SceneBar
            centre={centre}
            root={selected}
            inView={inView}
            trailOpen={!!trailOpen}
            onBack={() => select({ trail: null, item: null })}
            onCentre={(c) => select({ centre: c })}
            views={inView ? views.of(inView.id) : []}
            viewShown={views.shown}
            viewError={views.error}
            onView={views.open}
          />
          <div className={centre ? "min-h-0 flex-1 bg-card" : "min-h-0 flex-1"}>
            {/* The panes stay mounted under the whole run and the agents, so coming back is instant. */}
            <div className="h-full [&[hidden]]:hidden" hidden={!!centre}>
              {panes}
            </div>
            {centre === "run" && (
              <RunGraphView fold={fold} selected={inView?.id} rows={review.rows} onPick={show} />
            )}
            {centre === "agents" && (
              <RunAgents events={events} fold={fold} live={live} nameOf={nameOf} />
            )}
          </div>
        </div>
        <SidePanel
          side="right"
          title="Final outputs"
          icon={<Sigma />}
          badge={needing || undefined}
          badgeLabel={`${needing} need you`}
          tools={
            <>
              <Button
                size="sm"
                variant={onlyNeeds ? "secondary" : "ghost"}
                aria-pressed={onlyNeeds}
                disabled={needing === 0 && !onlyNeeds}
                onClick={() => setOnlyNeeds(!onlyNeeds)}
              >
                Needs you <span className="font-semibold">{needing}</span>
              </Button>
              <Button
                size="sm"
                variant={centre === "run" ? "secondary" : "ghost"}
                aria-pressed={centre === "run"}
                aria-keyshortcuts="w"
                onClick={toggleRun}
              >
                <Workflow aria-hidden />
                Whole run
              </Button>
            </>
          }
        >
          <FinalOutputs
            review={review}
            selected={selected}
            onSelect={(id) => select({ output: id, item: null, trail: null })}
            open={trailOpen?.id}
            onOpen={(id) => select({ trail: id, item: null, centre: null })}
            onlyNeeds={onlyNeeds}
            live={live}
            runId={run.id}
            events={events}
            fold={fold}
            nameOf={nameOf}
            item={item?.key}
            onItem={(i) => {
              select({ item: i.key, trail: null, centre: null });
              setPicked((n) => n + 1);
            }}
            accepting={accepting}
          />
        </SidePanel>
      </div>
    </>
  );
}

/** Above the centre: what it shows, and the way to the whole run and the agents and back. */
function SceneBar({
  centre,
  root,
  inView,
  trailOpen,
  onBack,
  onCentre,
  views,
  viewShown,
  viewError,
  onView,
}: {
  centre: Centre | undefined;
  root: OutputRow | undefined;
  inView: OutputRow | undefined;
  trailOpen: boolean;
  onBack: () => void;
  onCentre: (centre: Centre | null) => void;
  /** The views saved of the output in view, oldest first. */
  views: SavedView[];
  /** The saved view the panes were last set to. */
  viewShown: string | undefined;
  viewError: string | undefined;
  onView: (view: SavedView) => void;
}) {
  const bar = "flex h-10 shrink-0 items-center gap-3 border-b border-border bg-card px-3 text-sm";
  if (centre)
    return (
      <header className={bar}>
        <h2 className="font-semibold">
          {centre === "run" ? "The whole run" : "Agents on this run"}
        </h2>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onCentre(null)} aria-keyshortcuts="Escape">
          <ChevronLeft aria-hidden />
          Back to the views
        </Button>
      </header>
    );
  if (!inView || !root) return null;
  const { status, word } = OUTPUT_STATUS[inView.state.status];
  // A reported value can still rest on something to check.
  const inherited =
    !trailOpen &&
    inView.state.status === "reported" &&
    inView.items.some((i) => !i.resolved && i.output !== inView.id);
  return (
    <header className={bar}>
      {trailOpen ? (
        <button
          type="button"
          onClick={onBack}
          aria-keyshortcuts="Escape"
          className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        >
          {root.name} ›
        </button>
      ) : (
        inView.state.section && (
          <span className="shrink-0 text-xs text-muted-foreground">{inView.state.section}</span>
        )
      )}
      <h2 className="min-w-0 truncate font-semibold">{inView.name}</h2>
      {inView.value && (
        <span className="shrink-0 font-mono tabular-nums">
          {inView.value.text}
          <span className="text-muted-foreground"> {inView.value.unit}</span>
        </span>
      )}
      <StatusMark
        status={inherited ? "check" : status}
        label={inherited ? "Rests on a To check" : word}
        className="shrink-0"
      />
      <span className="flex-1" />
      {viewError && (
        <span className="text-xs text-destructive" role="alert">
          {viewError}
        </span>
      )}
      {views.length > 0 && (
        <Menu
          align="end"
          trigger={
            <Button size="sm" variant="ghost">
              <Bookmark aria-hidden />
              {views.find((v) => v.id === viewShown)?.title ?? "Saved views"}
              <ChevronDown aria-hidden />
            </Button>
          }
        >
          {views.map((v) => (
            <MenuItem key={v.id} onSelect={() => onView(v)}>
              <span className="flex items-baseline justify-between gap-3">
                <span>{v.title}</span>
                <span className="text-xs text-fg-subtle">{v.time}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
      <Button size="sm" variant="ghost" onClick={() => onCentre("agents")}>
        Agents
      </Button>
    </header>
  );
}

/** The output on the panes, with a note for what it names that can't be drawn yet. */
function OutputScene({
  runId,
  blocks,
  assets,
  subject,
  shown,
  nameOf,
  focus,
  marking,
  quad,
}: {
  runId: string;
  blocks: ReturnType<typeof outputBlocks>;
  assets: ReturnType<typeof reviewAssetsOf>;
  subject: string;
  shown: string[];
  nameOf: (id: string) => string;
  focus: OutputItem["focus"];
  marking: ReturnType<typeof useMarking>;
  quad: NonNullable<React.ComponentProps<typeof SceneViewer>["quad"]>;
}) {
  const missing = undrawn(blocks, shown);
  // A new array per render would rebuild the scene on every frame of the stream.
  const shownKey = shown.join();
  const stable = useMemo(() => ({ id: subject, shown }), [subject, shownKey]);
  return (
    <div className="flex h-full flex-col">
      {missing.length > 0 && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Not drawn yet: {missing.map(nameOf).join(", ")}.
        </p>
      )}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <Centered>
              <LoadingState label="Loading the viewer" rows={3} className="w-72" />
            </Centered>
          }
        >
          <SceneViewer
            runId={runId}
            revision={blocks}
            subject={stable}
            assets={assets}
            display={NO_DISPLAY}
            focus={focus}
            tool={marking.tool}
            onTool={marking.setTool}
            tools={marking.tools}
            marks={marking.marks}
            selected={marking.selected}
            jump={marking.jump}
            onJumped={marking.jumped}
            onMark={(mark, volumeId, gridKey, plane) =>
              marking.add(mark, volumeId, gridKey, subject, plane)
            }
            full={marking.full}
            onShown={marking.setShown}
            quad={quad}
          />
        </Suspense>
      </div>
    </div>
  );
}
const NO_DISPLAY = {};

/**
 * Looks right on a To check item. The decision is an event the stream brings: once saved, the
 * stream reconnects to fetch it (an ended run's stream has closed).
 */
function useAcceptToCheck(run: { id: string; example: boolean }, reopen: () => void): Accepting {
  const [error, setError] = useState<{ key: string; text: string }>();
  const mutation = useMutation<void, Error, OutputItem>({
    mutationFn: (i) =>
      acceptToCheck(run.id, { output: i.output, version: i.version, item: i.item }),
    onMutate: (i) => setError((e) => (e?.key === i.key ? undefined : e)),
    onSuccess: reopen,
    onError: (e, i) =>
      setError({
        key: i.key,
        text:
          e instanceof ApiError && e.serverMessage ? e.serverMessage : "Couldn't save. Try again.",
      }),
  });
  if (run.example) return { readOnly: "Example runs can't be changed." };
  return {
    accept: (i) => mutation.mutate(i),
    pending: mutation.isPending ? mutation.variables?.key : undefined,
    error,
  };
}

/**
 * The conversation with the run's main AI, read-only: researchers write to it on runs of this kind
 * once corrections arrive. The views you saved show in it, where they fall. Under it, your marks
 * are kept in the run and wait for the message that will carry them: a chip goes to its mark, × removes it.
 */
function MainConversation({
  live,
  nameOf,
  marking,
  markError,
}: {
  live: boolean;
  nameOf: (id: string) => string;
  marking: ReturnType<typeof useMarking>;
  markError: string | undefined;
}) {
  const events = useEvents();
  const mine = marking.marks.filter((m) => !m.theirs);
  // A run of this kind has no corrections, so no correction outcomes: messages, and saved views.
  const items = useMemo(() => {
    const said = conversation(events)
      .filter((m): m is Exclude<typeof m, { from: "outcome" }> => m.from !== "outcome")
      .map((m) => ({ ...m, kind: "message" as const }));
    const saved = savedViews(events).map((v) => ({ ...v, kind: "view" as const }));
    return [...said, ...saved].sort((a, b) => a.seq - b.seq);
  }, [events]);
  const log = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && items.length > 0) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  return (
    <div className="flex h-full flex-col">
      <div ref={log} role="log" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <EmptyState title="No messages yet">
            {live ? "The AI writes here when it has something for you." : undefined}
          </EmptyState>
        ) : (
          <ol className="grid gap-3">
            {items.map((m) =>
              m.kind === "view" ? (
                <li key={m.id} className="flex gap-2 text-xs text-muted-foreground">
                  <Bookmark aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    You saved {m.title.toLowerCase()} of {nameOf(m.output)}
                    {m.words && `, ${m.words.charAt(0).toLowerCase()}${m.words.slice(1)}`}.
                  </span>
                </li>
              ) : m.from === "person" ? (
                <li key={m.id} className="ml-6 grid gap-1 rounded-lg bg-muted px-3 py-2">
                  <span className="text-xs text-muted-foreground">You</span>
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                </li>
              ) : (
                <li key={m.id} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">The AI</span>
                  <Markdown text={m.text} className="text-sm" />
                </li>
              ),
            )}
          </ol>
        )}
      </div>
      <div className="grid gap-2 border-t border-border p-3 text-xs text-muted-foreground">
        {markError && <p role="alert">{markError}</p>}
        {mine.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span>With your next message:</span>
            {mine.map((m) => {
              const { title, measure } = describe(m.mark, marking.tools);
              return (
                <Chip key={m.id} className="gap-0.5 pr-0.5 text-mark-mine-text">
                  <button
                    type="button"
                    className="cursor-pointer font-mono"
                    title={measure ? `${title}: ${measure}` : title}
                    onClick={() => marking.select(m.id)}
                  >
                    {m.tag}
                  </button>
                  <IconButton
                    size="sm"
                    label={`Remove ${m.tag}`}
                    onClick={() => marking.remove(m.id)}
                  >
                    <X />
                  </IconButton>
                </Chip>
              );
            })}
          </div>
        )}
        <p>
          You can't write to the AI on this run yet. Corrections through the AI come in a later
          version; until then, accept To check items in Final outputs.
        </p>
      </div>
    </div>
  );
}

/** A view saved of an output: its title ("View 2"), when, and how its planes lay in words. */
type SavedView = {
  id: string;
  seq: number;
  output: string;
  view: unknown;
  title: string;
  time: string;
  words?: string;
};

/** The run's saved views, oldest first, each numbered among its output's. */
function savedViews(events: ReturnType<typeof useEvents>): SavedView[] {
  const count = new Map<string, number>();
  return events.flatMap((e) => {
    if (e.type !== "view.saved") return [];
    const n = (count.get(e.payload.output) ?? 0) + 1;
    count.set(e.payload.output, n);
    return [
      {
        id: e.id,
        seq: e.seq,
        output: e.payload.output,
        view: e.payload.view,
        title: `View ${n}`,
        time: new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        words: storedWords(e.payload.view),
      },
    ];
  });
}

/**
 * Saving a view (`view.saved`, which the stream brings back) and opening one. Example runs can't
 * be changed, so they have no Save view.
 */
function useSavedViews(run: { id: string; example: boolean }, reopen: () => void) {
  const events = useEvents();
  const all = useMemo(() => savedViews(events), [events]);
  const [restore, setRestore] = useState<{ grid: string; state: QuadState }>();
  const [shown, setShown] = useState<string>();
  const [error, setError] = useState<string>();
  const mutation = useMutation<void, Error, { output: string; view: ReturnType<typeof storeView> }>(
    {
      mutationFn: (body) => saveView(run.id, body),
      onMutate: () => setError(undefined),
      onSuccess: reopen,
      onError: (e) =>
        setError(
          e instanceof ApiError && e.serverMessage ? e.serverMessage : "Couldn't save the view.",
        ),
    },
  );
  // The newest saved view of what was just saved is the one shown.
  const pendingFor = useRef<string>(undefined);
  useEffect(() => {
    const output = pendingFor.current;
    if (!output) return;
    const newest = all.filter((v) => v.output === output).at(-1);
    if (newest) setShown(newest.id);
  }, [all]);
  return {
    of: (output: string) => all.filter((v) => v.output === output),
    shown,
    error,
    restore,
    save: run.example
      ? undefined
      : (row: OutputRow, state: QuadState, grid: string) => {
          pendingFor.current = row.id;
          mutation.mutate({ output: row.id, view: storeView(state, grid, shownOf(row)) });
        },
    open: (v: SavedView) => {
      const grid = (v.view as { review?: { grid?: string } }).review?.grid;
      const state = grid ? readView(v.view, grid) : undefined;
      if (!grid || !state) {
        setError("This view can't be opened here.");
        return;
      }
      setError(undefined);
      setShown(v.id);
      setRestore({ grid, state });
    },
  };
}

/** Gated calls main is holding for the researcher: requested, not yet given or declined. */
function waitingApprovals(events: readonly RunEvent[]): number {
  const open = new Set<string>();
  for (const e of events)
    if (e.type === "approval.requested") open.add(e.payload.toolCallId);
    else if (e.type === "approval.given" || e.type === "approval.declined")
      open.delete(e.payload.toolCallId);
  return open.size;
}

/** The Samples tab (`INPUT_WORD`): every study's samples, this run's study open and its sample highlighted. */
function Samples({ studyId, runId }: { studyId: string; runId: string }) {
  const studies = useQuery(studiesQuery());
  const tree = useMemo(() => sampleTree(studies.data ?? []), [studies.data]);
  if (studies.isError)
    return (
      <ErrorState
        className="m-3"
        title={`Couldn't load the ${INPUT_WORD.many}`}
        onRetry={() => void studies.refetch()}
      >
        Check your connection, then try again.
      </ErrorState>
    );
  if (!studies.data)
    return <LoadingState label={`Loading the ${INPUT_WORD.many}`} rows={4} className="m-3" />;
  return (
    <SampleTree
      studies={tree}
      studyId={studyId}
      sampleId={runId}
      renderLink={(href, props) => <Link to={href} {...props} />}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

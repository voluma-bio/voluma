/**
 * The input review of a run (Q24, mockup C), in the shell's two side panels. The
 * left side's tabs: the conversation with the run's main AI (the default, and the only place
 * anything on the run changes: `main-conversation.tsx`; badged while main waits on your yes) and
 * the inputs (the shared tree, named by `INPUT_WORD`). In the centre the output in view on four panes (`QuadViewer`) with
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
import { ApiError, acceptToCheck } from "@voluma/api-client";
import { studyQuery } from "@voluma/api-client/query";
import { agentLog, openApprovals } from "@voluma/contracts/agents";
import type { Me } from "@voluma/contracts/auth";
import { conversation } from "@voluma/contracts/conversation";
import { outputsFold } from "@voluma/contracts/output-fold";
import { toVoxel } from "@voluma/contracts/ruler";
import type { RunRead } from "@voluma/contracts/run";
import {
  type AgentLinks,
  agentEntries,
  inViewOf,
  isLive,
  type OutputItem,
  type OutputRow,
  outputBlocks,
  outputName,
  outputsReview,
  reviewAssetsOf,
  shownOf,
  undrawn,
  useEvents,
} from "@voluma/run-view";
import {
  Button,
  EmptyState,
  INPUT_WORD,
  LoadingState,
  Menu,
  MenuItem,
  SidePanel,
  StatusMark,
  useFoldWhile,
  useFullView,
} from "@voluma/ui";
import {
  type GridPlanes,
  type MarkEdit,
  type MarkPlane,
  type PlaneFit,
  QUAD_START,
  type QuadLayout,
  type Zyx,
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
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { FileOutput } from "./file-output";
import { InputHeading, RunAlert } from "./input-header";
import { MainConversation } from "./main-conversation";
import { gridKeyOf, useLocalMarks, useMarking } from "./marking";
import { FinalOutputs, restsOnOpen, statusOf } from "./outputs-panel";
import { RunAgents } from "./run-agents";
import { RunGraphView } from "./run-graph";
import { useRunMarks } from "./run-marks";
import { RunNews } from "./run-news";
import { Samples } from "./samples-tab";
import { type SavedView, savedViews, useSavedViews } from "./saved-views";
import { useAnswers, useMainMessage } from "./use-main-message";
import type { Accepting } from "./version-report";
import type { SceneHandle } from "./viewer";

// three.js and the zarr reader load only once there is an output to show.
const SceneViewer = lazy(() => import("./viewer").then((m) => ({ default: m.SceneViewer })));

type Centre = "run" | "agents";

export function OutputsReview({
  run,
  stale,
  refetchRun,
  reopen,
}: {
  run: RunRead;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  /** Reads the run again: a message or an answer reopens an ended one. */
  refetchRun: () => void;
  /** Reconnects the run's stream, to catch what a write of yours added to the log. */
  reopen: () => void;
}) {
  const me = useOutletContext<Me>();
  const study = useQuery({
    ...studyQuery(run.studyId),
    refetchInterval: (query) =>
      isLive(run) || query.state.data?.inputs.some((input) => isLive(input.runs[0])) ? 5000 : false,
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
      agent?: string | null;
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
    (id: string) => listed.find((r) => r.trail.some((t) => t.id === id)),
    [listed],
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
  const live = run.state.status !== "ended";
  const { trailOpen, standIn, soFar } = inViewOf(review, selected, opened, live, blocks);
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
  const inView = trailOpen ?? standIn ?? selected;
  const centreParam = params.get("centre");
  const centre: Centre | undefined =
    centreParam === "run" || centreParam === "agents" ? centreParam : undefined;
  const item = selected?.items.find((i) => i.key === params.get("item"));
  // The agents a name can open: each agent's thread names (`main.2` opens main's thread).
  const agents = useMemo(() => agentEntries(events, fold, live), [events, fold, live]);
  // The links change only when the set of names does, and `open` reads the latest entries and
  // `select`, so the conversation's replies don't re-render on every event of a live run.
  const nameKey = agents.flatMap((a) => a.names).join("\n");
  const latest = useRef({ agents, select });
  latest.current = { agents, select };
  const agentLinks = useMemo<AgentLinks>(
    () => ({
      names: new Set(nameKey ? nameKey.split("\n") : []),
      open: (name) =>
        latest.current.select({
          centre: "agents",
          agent: latest.current.agents.find((a) => a.names.includes(name))?.name ?? name,
        }),
    }),
    [nameKey],
  );
  // Show moves the crosshair once per press: a new object each time.
  const [picked, setPicked] = useState(0);
  const focusKey = item?.focus && JSON.stringify(item.focus);
  const focus = useMemo(() => item?.focus && { ...item.focus }, [focusKey, picked]);

  const [onlyToCheck, setOnlyToCheck] = useState(false);
  const toCheck = review.open.size;
  const [leftTab, setLeftTab] = useState("conversation");
  const said = useMemo(() => conversation(events), [events]);
  const runMarks = useRunMarks({
    run,
    me: me.userId,
    events,
    volumes: blocks.volumes,
    reopen,
  });
  // An example run keeps no marks (its writes are refused): they are the page's.
  const exampleMarks = useLocalMarks();
  const store = run.example ? exampleMarks : runMarks;
  const settled = runMarks.settled;
  const marking = useMarking(store);
  // Opening a published ruler or point puts the slices through its first end once, so a Navigate
  // drag can take it; a To check item's own focus wins, and later events leave the slices alone.
  const inViewId = inView?.id;
  const aimedFor = useRef<string | undefined>(undefined);
  const { jumpTo } = marking;
  const inViewLoaded = !!inView?.state.latest;
  useEffect(() => {
    if (!inViewId || item) return;
    const a = blocks.annotations.find((x) => x.id === inViewId);
    // Another loaded output in view ends the aim, so coming back to the ruler aims again.
    if (!a && inViewLoaded) aimedFor.current = undefined;
    if (aimedFor.current === inViewId) return;
    const on = a && blocks.volumes.find((v) => v.id === a.volumeId);
    const image = on && blocks.volumes.find((v) => v.kind === "image" && v.gridId === on.gridId);
    const gridKey = image && gridKeyOf(image);
    // The jump needs the image's real shape, which arrives with its converted assets.
    if (!a || image?.data?.format !== "npy" || !gridKey) return;
    if (assets[image.data.sha256]?.state !== "ready") return;
    aimedFor.current = inViewId;
    const end = toVoxel(image.affine, a.kind === "point" ? a.position : a.a);
    const at = end.map((n, i) => Math.max(0, Math.min(image.shapeZyx[i]! - 1, Math.round(n))));
    jumpTo({ at: at as unknown as Zyx, gridKey, output: inViewId });
  }, [inViewId, inViewLoaded, item, blocks, assets, jumpTo]);
  const allViews = useMemo(() => savedViews(events), [events]);
  const views = useSavedViews(run, allViews, reopen);
  const scene = useRef<SceneHandle>(null);
  const sent = useCallback(() => {
    reopen();
    refetchRun();
  }, [reopen, refetchRun]);
  // The panes show the output: a picture of them can go with a message.
  const pictured =
    inView?.state.latest && inView.state.kind !== "file" && inView.state.kind !== "collection"
      ? inView.name
      : undefined;
  const message = useMainMessage({
    run,
    events,
    changes: store.changes,
    inView,
    picture: pictured,
    scene,
    settled,
    onSent: sent,
  });
  const answers = useAnswers(run, sent);
  // Calls main holds for your yes: while one is open and you can answer, the run waits on you,
  // whatever its row says.
  const waiting = answers.answer ? openApprovals(agentLog(events).approvals).length : 0;
  const accepting: Accepting = {
    ...useAcceptToCheck(run, reopen),
    ...(!run.example && {
      tell: (i: OutputItem) => {
        message.setAbout({ item: i, name: nameOf(i.output) });
        setLeftTab("conversation");
      },
    }),
  };
  // An edit is a correction: the mark is written now, and waits for your next message.
  const latestEdit = useRef({ marks: marking.marks, store, add: marking.add });
  latestEdit.current = { marks: marking.marks, store, add: marking.add };
  const onEdit = useCallback(
    (edit: MarkEdit, volumeId: string, gridKey: string, plane: MarkPlane) => {
      const { marks, store: kept, add } = latestEdit.current;
      if (edit.from === "mark") {
        const m = marks.find((x) => x.id === edit.id);
        if (m && !m.theirs) kept.place({ ...m, mark: edit.mark, plane });
      } else add(edit.mark, volumeId, gridKey, edit.id, plane);
    },
    [],
  );
  // Delete takes away the mark you picked; one main was told of waits as a deletion.
  const deleteMark = useCallback((id: string) => {
    const { marks, store: kept } = latestEdit.current;
    const m = marks.find((x) => x.id === id);
    if (m && !m.theirs) kept.erase(id);
  }, []);

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
  const keys = useRef({
    layout,
    centre,
    trailOpen,
    shellFull,
    picked: marking.selected,
    deleteMark,
  });
  keys.current = { layout, centre, trailOpen, shellFull, picked: marking.selected, deleteMark };
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
      } else if ((event.key === "Delete" || event.key === "Backspace") && k.picked) {
        event.preventDefault();
        k.deleteMark(k.picked);
      } else if (event.key === "Escape" && !k.shellFull) {
        if (k.centre) select({ centre: null });
        else if (k.trailOpen) select({ trail: null, item: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, toggleRun]);

  let panes: React.ReactNode;
  if (live && inView?.state.status !== "missing" && !inView?.state.latest)
    panes = (
      <Centered>
        <EmptyState title="The run is going">
          The AI is still setting up. What it makes shows here as it is published, and its plan in
          the conversation.
        </EmptyState>
      </Centered>
    );
  else if (!inView)
    panes = (
      <Centered>
        <EmptyState title="No outputs yet" />
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
          {inView.state.missingReason ?? "The run ended without it."}
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
          grids: blocks.grids,
          onNote: marking.note,
          onSave: views.save && ((state, grid) => views.save!(inView, state, grid)),
          restore: views.restore,
          onEdit,
          onPick: marking.select,
          ref: scene,
        }}
      />
    );

  return (
    <>
      <InputHeading run={run} study={study.data} waitingOnYou={waiting > 0} />
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
                  conversation={said}
                  views={allViews}
                  live={live}
                  nameOf={nameOf}
                  agents={agentLinks}
                  checkTitle={(t) =>
                    fold.byId.get(t.output)?.versions.find((v) => v.version === t.version)?.toCheck[
                      t.item
                    ]?.title
                  }
                  message={message}
                  answers={answers}
                  markError={runMarks.error}
                  onMark={marking.select}
                  onDiscard={store.discard}
                />
              ),
            },
            {
              id: "samples",
              label: INPUT_WORD.Many,
              icon: <ListTree />,
              content: <Samples studyId={run.studyId} inputId={run.input.id} />,
            },
          ]}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <RunAlert run={run} userId={me.userId} stale={stale} />
          <SceneBar
            centre={centre}
            live={live}
            root={selected}
            standIn={!!standIn}
            soFar={!!soFar}
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
              <RunAgents
                events={events}
                agents={agents}
                picked={params.get("agent")}
                onPick={(name) => select({ agent: name })}
                links={agentLinks}
                live={live}
                nameOf={nameOf}
              />
            )}
          </div>
        </div>
        <SidePanel
          side="right"
          title="Final outputs"
          meta={
            live && review.progress.total > 0
              ? `${review.progress.done} of ${review.progress.total} in`
              : undefined
          }
          icon={<Sigma />}
          badge={toCheck || undefined}
          badgeLabel={`${toCheck} to check`}
          tools={
            <>
              {(!live || toCheck > 0 || onlyToCheck) && (
                <Button
                  size="sm"
                  variant={onlyToCheck ? "secondary" : "ghost"}
                  aria-pressed={onlyToCheck}
                  disabled={toCheck === 0 && !onlyToCheck}
                  onClick={() => setOnlyToCheck(!onlyToCheck)}
                >
                  To check <span className="font-semibold">{toCheck}</span>
                </Button>
              )}
              <Button
                size="sm"
                variant={centre === "run" ? "secondary" : "ghost"}
                aria-pressed={centre === "run"}
                aria-keyshortcuts="w"
                onClick={toggleRun}
                title={live ? "Whole run (W)" : undefined}
              >
                <Workflow aria-hidden />
                {/* Its icon alone while the run goes: the head also counts what is in. */}
                <span className={live ? "sr-only" : undefined}>Whole run</span>
              </Button>
            </>
          }
        >
          {live && <RunNews events={events} state={run.state} />}
          <FinalOutputs
            review={review}
            selected={selected}
            onSelect={(id) => select({ output: id, item: null, trail: null })}
            open={trailOpen?.id}
            onOpen={(id) => select({ trail: id, item: null, centre: null })}
            onlyToCheck={onlyToCheck}
            live={live}
            runId={run.id}
            events={events}
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
  live,
  root,
  standIn,
  soFar,
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
  live: boolean;
  root: OutputRow | undefined;
  /** `inView` is what `root`, not in yet, rests on. */
  standIn: boolean;
  /** `inView` is the run's newest drawable output, shown while nothing `root` rests on is in. */
  soFar: boolean;
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
  if (!inView || (!root && !soFar)) return null;
  const { status, word } = statusOf(inView, live);
  // A reported value can still rest on something to check.
  const inherited = !trailOpen && restsOnOpen(inView);
  return (
    <header className={bar}>
      {trailOpen ? (
        <button
          type="button"
          onClick={onBack}
          aria-keyshortcuts="Escape"
          className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        >
          {root?.name} ›
        </button>
      ) : soFar ? (
        <span className="shrink-0 text-xs text-muted-foreground">Made so far, not final:</span>
      ) : standIn && root ? (
        <span className="shrink-0 text-xs text-muted-foreground">{root.name} is based on</span>
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
      <StatusMark status={status} label={word} className="shrink-0" />
      {inherited && (
        <span className="shrink-0 text-muted-foreground text-xs">An input needs checking</span>
      )}
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
            focus={focus}
            tool={marking.tool}
            onTool={marking.setTool}
            marks={marking.marks}
            selected={marking.selected}
            jump={marking.jump}
            onJumped={marking.jumped}
            onMark={(mark, volumeId, gridKey, plane) =>
              marking.add(mark, volumeId, gridKey, subject, plane)
            }
            onShown={marking.setShown}
            quad={quad}
          />
        </Suspense>
      </div>
    </div>
  );
}

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

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

/**
 * The scan review of a run of the agent loop (Q24, mockup C): the conversation with the run's main
 * AI on the left (read-only until researchers can write to it on this kind of run); in the centre
 * the output in view on four panes (`QuadViewer`) with the tool bar docked under them, or a file
 * output, the whole run's graph (W) or the run's agents in the panes' place; on the right the
 * final outputs above the trail of the one picked ("How the AI got here"). Everything comes from
 * the run's stream as it arrives: the output fold (`outputsFold`), its converted assets and the
 * conversation, so statuses and values update live.
 *
 * The URL keeps `output` (the output picked in Final outputs, the trail's root), `trail` (an
 * output of its trail whose report is open and which the panes show), `item` (the To check item
 * whose place the panes show) and `centre` (`run` for the whole run, `agents`). The panes' layout
 * is page state: it holds while another output, on another grid, is shown.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, acceptToCheck, saveView } from "@voluma/api-client";
import { studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import { conversation } from "@voluma/contracts/conversation";
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
  shownOf,
  undrawn,
  useEvents,
} from "@voluma/run-view";
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  LoadingState,
  Menu,
  MenuItem,
  ShellPanel,
  StatusMark,
  useFullView,
} from "@voluma/ui";
import {
  type GridPlanes,
  type PlaneFit,
  QUAD_START,
  type QuadLayout,
  type QuadState,
  readView,
  storeView,
} from "@voluma/viewer/grid";
import { outputCatalogOf } from "@voluma/workflow/output-catalogs";
import {
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ListTree,
  MessagesSquare,
  Network,
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
import { useOutletContext, useSearchParams } from "react-router";
import { FileOutput } from "./file-output";
import { describe, QUAD_TOOLS, useMarking } from "./marks-panel";
import { type Accepting, OUTPUT_STATUS, OutputsPanel } from "./outputs-panel";
import { RunAgents } from "./run-agents";
import { RunGraphView } from "./run-graph";
import { RunAlert, ScanHeading } from "./scan-header";
import { TrailPanel } from "./trail-panel";

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
  // Under 1440 px, two panels leave the panes too narrow: the conversation waits for C (I is Probe).
  const [wide] = useState(() => globalThis.innerWidth >= 1440);
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
  // The trail's root: the URL's, else the first final output with an open item, else the first.
  const finals = review.sections.flatMap((s) => s.rows);
  const selected =
    review.rows.get(params.get("output") ?? "") ??
    finals.find((r) => r.items.some((i) => !i.resolved)) ??
    finals[0] ??
    review.undeclared[0];
  const opened = review.rows.get(params.get("trail") ?? "");
  const trailOpen = opened && opened.id !== selected?.id ? opened : undefined;
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
  const live = run.state.status !== "ended";
  const marking = useMarking(QUAD_TOOLS);
  const views = useSavedViews(run, reopen);

  // A pane fills the centre in the shell's Full view: filling one folds the side panels, and
  // leaving Full view (Esc, F, opening a panel) puts the panes back.
  const [shellFull, setShellFull] = useFullView();
  const [layout, setLayout] = useState<QuadLayout>(QUAD_START);
  const keys = useRef({ layout, centre, trailOpen, shellFull });
  keys.current = { layout, centre, trailOpen, shellFull };
  const onLayout = useCallback(
    (next: QuadLayout) => {
      if (!!next.full !== !!keys.current.layout.full) setShellFull(!!next.full);
      setLayout(next);
    },
    [setShellFull],
  );
  const wasFull = useRef(shellFull);
  useEffect(() => {
    if (wasFull.current && !shellFull)
      setLayout((had) => (had.full ? { ...had, full: null } : had));
    wasFull.current = shellFull;
  }, [shellFull]);
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
        select({ centre: k.centre === "run" ? null : "run" });
      } else if (event.key === "Escape" && !k.shellFull) {
        if (k.centre) select({ centre: null });
        else if (k.trailOpen) select({ trail: null, item: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

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
      <ShellPanel
        id="scan-ai"
        side="left"
        group="scan"
        label="The AI"
        icon={<MessagesSquare />}
        shortcut="c"
        defaultOpen={wide}
      >
        <MainConversation live={live} nameOf={nameOf} marking={marking} />
      </ShellPanel>
      <ShellPanel
        id="scan-outputs"
        side="right"
        label="Final outputs"
        icon={<ListTree />}
        count={review.open}
        defaultOpen
      >
        <OutputsPanel
          review={review}
          selected={selected}
          onSelect={(id) => select({ output: id, item: null, trail: null })}
          live={live}
        />
      </ShellPanel>
      <ShellPanel
        id="scan-trail"
        side="right"
        label="How the AI got here"
        icon={<Network />}
        defaultOpen
        tools={
          <Button
            size="sm"
            variant={centre === "run" ? "secondary" : "ghost"}
            aria-pressed={centre === "run"}
            aria-keyshortcuts="w"
            onClick={() => select({ centre: centre === "run" ? null : "run" })}
          >
            <Workflow aria-hidden />
            Whole run
          </Button>
        }
      >
        {selected ? (
          <TrailPanel
            runId={run.id}
            events={events}
            fold={fold}
            root={selected}
            open={trailOpen?.id}
            onOpen={(id) => select({ trail: id, item: null, centre: null })}
            onReroot={(id) => select({ output: id, trail: null, item: null })}
            nameOf={nameOf}
            item={item?.key}
            onItem={(i) => {
              select({ item: i.key, trail: null, centre: null });
              setPicked((n) => n + 1);
            }}
            accepting={accepting}
          />
        ) : (
          <div className="p-4">
            <EmptyState title="Nothing picked">
              {live ? "The outputs appear once the AI has set them up." : undefined}
            </EmptyState>
          </div>
        )}
      </ShellPanel>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
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
            <RunGraphView
              fold={fold}
              selected={selected?.id}
              rows={review.rows}
              onPick={(id) => select({ output: id, trail: null, item: null })}
            />
          )}
          {centre === "agents" && <RunAgents events={events} fold={fold} nameOf={nameOf} />}
        </div>
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
          {centre === "run" ? "How the AI got here: the whole run" : "Agents on this run"}
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
      <Button size="sm" variant="ghost" onClick={() => onCentre("run")} aria-keyshortcuts="w">
        <Workflow aria-hidden />
        Whole run
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
            onMark={(mark, volumeId, gridKey) => marking.add(mark, volumeId, gridKey, subject)}
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
 * wait for the message that will carry them: a chip goes to its mark, × removes it.
 */
function MainConversation({
  live,
  nameOf,
  marking,
}: {
  live: boolean;
  nameOf: (id: string) => string;
  marking: ReturnType<typeof useMarking>;
}) {
  const events = useEvents();
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
                    {m.words && `: ${m.words}`}.
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
        {marking.marks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span>With your next message:</span>
            {marking.marks.map((m) => {
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
          version; until then, accept To check items in How the AI got here.
        </p>
      </div>
    </div>
  );
}

/** A view saved of an output: its title ("View 2"), when, and what it was in words. */
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
    const review = (
      e.payload.view as {
        review?: {
          aligned?: { name?: string } | null;
          layout?: { views?: string[]; count?: number };
        };
      }
    ).review;
    const panes = review?.layout?.views
      ?.slice(0, review.layout.count ?? 4)
      .map((v) => v.toUpperCase().replace("3D", "3D"));
    const along = review?.aligned?.name;
    return [
      {
        id: e.id,
        seq: e.seq,
        output: e.payload.output,
        view: e.payload.view,
        title: `View ${n}`,
        time: new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        words:
          [along && `along ${along}`, panes?.join(", ")].filter(Boolean).join("; ") || undefined,
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

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

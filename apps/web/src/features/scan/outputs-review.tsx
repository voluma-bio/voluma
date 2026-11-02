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
import { ApiError, acceptToCheck } from "@voluma/api-client";
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
import { Button, EmptyState, LoadingState, ShellPanel, StatusMark, useFullView } from "@voluma/ui";
import { type GridPlanes, QUAD_START, type QuadLayout } from "@voluma/viewer/grid";
import { outputCatalogOf } from "@voluma/workflow/output-catalogs";
import { ChevronLeft, ListTree, MessagesSquare, Network, Workflow } from "lucide-react";
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
import { useMarking } from "./marks-panel";
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
  // Under 1440 px, two panels leave the panes too narrow: the conversation waits for i.
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
  const marking = useMarking();

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
        quad={{ layout, onLayout, planesOf }}
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
        shortcut="i"
        defaultOpen={wide}
      >
        <MainConversation live={live} />
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
}: {
  centre: Centre | undefined;
  root: OutputRow | undefined;
  inView: OutputRow | undefined;
  trailOpen: boolean;
  onBack: () => void;
  onCentre: (centre: Centre | null) => void;
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
 * once corrections arrive.
 */
function MainConversation({ live }: { live: boolean }) {
  const events = useEvents();
  // A run of this kind has no corrections, so no correction outcomes: messages only.
  const items = useMemo(
    () =>
      conversation(events).filter(
        (m): m is Exclude<typeof m, { from: "outcome" }> => m.from !== "outcome",
      ),
    [events],
  );
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
              m.from === "person" ? (
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
      <p className="border-t border-border p-3 text-xs text-muted-foreground">
        You can't write to the AI on this run yet. Corrections through the AI come in a later
        version; until then, accept To check items in How the AI got here.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

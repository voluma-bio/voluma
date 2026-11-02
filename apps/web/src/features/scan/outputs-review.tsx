/**
 * The scan review of a run of the agent loop: the conversation with the run's main AI on the left
 * (read-only until researchers can write to it on this kind of run), the run's final outputs on
 * the right (Outputs), and the output in view filling the main area in the 3D scene, on its base
 * with the overlays it is measured on and drawn with. Everything comes from the
 * run's stream as it arrives: the output fold (`outputsFold`), its converted assets and the
 * conversation, so statuses and values update live. The URL keeps `output` (the output in view)
 * and `item` (the To check item whose place the scene shows).
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
  outputBlocks,
  outputName,
  outputsReview,
  reviewAssetsOf,
  shownOf,
  undrawn,
  useEvents,
} from "@voluma/run-view";
import { EmptyState, LoadingState, ShellPanel } from "@voluma/ui";
import type { GridViewerHandle } from "@voluma/viewer/grid";
import { outputCatalogOf } from "@voluma/workflow/output-catalogs";
import { ListTree, MessagesSquare } from "lucide-react";
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { type Accepting, OutputsPanel } from "./outputs-panel";
import { RunAlert, ScanHeading } from "./scan-header";

// three.js and the zarr reader load only once there is an output to show.
const SceneViewer = lazy(() => import("./viewer").then((m) => ({ default: m.SceneViewer })));

const NO_MARKS: never[] = [];
const noop = () => {};

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
  // Under 1440 px, two panels leave the scene too narrow: the conversation waits for i.
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

  const [params, setParams] = useSearchParams();
  const select = useCallback(
    (patch: { output?: string; item?: string | null }) =>
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
  // The output in view: the URL's, else the first final output with an open item, else the first.
  const finals = review.sections.flatMap((s) => s.rows);
  const selected =
    review.rows.get(params.get("output") ?? "") ??
    finals.find((r) => r.items.some((i) => !i.resolved)) ??
    finals[0] ??
    review.undeclared[0];
  const item = selected?.items.find((i) => i.key === params.get("item"));
  // Show moves the crosshair once per press: a new object each time.
  const [picked, setPicked] = useState(0);
  const focusKey = item?.focus && JSON.stringify(item.focus);
  const focus = useMemo(() => item?.focus && { ...item.focus }, [focusKey, picked]);

  const accepting = useAcceptToCheck(run, reopen);
  const live = run.state.status !== "ended";

  let main: React.ReactNode;
  if (!selected)
    main = (
      <Centered>
        <EmptyState title="No outputs yet">
          {live ? "The outputs appear once the AI has set them up." : undefined}
        </EmptyState>
      </Centered>
    );
  else if (!selected.state.latest)
    main = (
      <Centered>
        <EmptyState
          title={
            selected.state.status === "missing"
              ? `${selected.name} is missing`
              : `${selected.name} isn't reported yet`
          }
        >
          {selected.state.missingReason ??
            (live ? "It shows here once the AI reports it." : "The run ended without it.")}
        </EmptyState>
      </Centered>
    );
  else if (selected.state.kind === "file" || selected.state.kind === "collection")
    main = (
      <Centered>
        <EmptyState title={`${selected.name} has no 3D view`}>
          Files and lists open here in a later version.
        </EmptyState>
      </Centered>
    );
  else
    main = (
      <OutputScene
        runId={run.id}
        blocks={blocks}
        assets={assets}
        subject={selected.id}
        shown={shownOf(selected)}
        title={sceneTitle(selected)}
        nameOf={nameOf}
        focus={focus}
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
        label="Outputs"
        icon={<ListTree />}
        count={review.open}
        shortcut="o"
        defaultOpen
      >
        <OutputsPanel
          review={review}
          selected={selected}
          onSelect={(id) => select({ output: id, item: null })}
          nameOf={nameOf}
          live={live}
          item={item?.key}
          onItem={(i) => {
            select({ item: i.key });
            setPicked((n) => n + 1);
          }}
          accepting={accepting}
        />
      </ShellPanel>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <RunAlert run={run} userId={me.userId} stale={stale} />
        <div className="min-h-0 flex-1">{main}</div>
      </div>
    </>
  );
}

/** The scene's heading: the output, and its value when it has one. */
function sceneTitle(row: { name: string; value?: { text: string; unit: string } }) {
  return row.value ? `${row.name} ${row.value.text} ${row.value.unit}`.trim() : row.name;
}

/** The output in the 3D scene, with a note for what it names that can't be drawn yet. */
function OutputScene({
  runId,
  blocks,
  assets,
  subject,
  shown,
  title,
  nameOf,
  focus,
}: {
  runId: string;
  blocks: ReturnType<typeof outputBlocks>;
  assets: ReturnType<typeof reviewAssetsOf>;
  subject: string;
  shown: string[];
  title: string;
  nameOf: (id: string) => string;
  focus: OutputItem["focus"];
}) {
  const viewer = useRef<GridViewerHandle>(null);
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
            title={title}
            assets={assets}
            display={NO_DISPLAY}
            focus={focus}
            tool={null}
            marks={NO_MARKS}
            selected={undefined}
            onJumped={noop}
            onMark={noop}
            onShown={noop}
            viewer={viewer}
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
        version; until then, accept To check items in Outputs.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-content-center p-6">{children}</div>;
}

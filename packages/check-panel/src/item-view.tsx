/**
 * One queue item: the grid viewer on the item's task, with the check (title, why it was raised,
 * "Looks right"), the task's values, what the view holds, and the chat with the run's AI beside
 * it. "Mark" turns clicks and drags on the slices into marks for the next message. Objects whose
 * 3D assets aren't ready show as preparing or couldn't prepare; they are never drawn from
 * anything else. Values a correction changed are blue, with what they were.
 */
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { ApiError, reviewAssetUrl } from "@voluma/api-client";
import { goMarkerId } from "@voluma/contracts/fold";
import { MAX_MARKS, type Mark } from "@voluma/contracts/messages";
import type { ReviewDecisionResponse, ReviewRun, ReviewTask } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import {
  type GridMark,
  GridViewer,
  type GridViewerHandle,
  type SceneObject,
  taskScene,
  type Zyx,
} from "@voluma/viewer/grid";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Chat, markLabel, type RunChat } from "./chat";
import type { CheckItem } from "./types";

/** How often a view still preparing asks whether its assets have arrived. */
const PREPARING_POLL_MS = 10_000;

type Accept = UseMutationResult<
  ReviewDecisionResponse,
  Error,
  { item: CheckItem; revisionId: string }
>;

const format = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

export function ItemView({
  item,
  review,
  runInfo,
  blocked,
  chat,
  canAccept,
  example,
  accepted,
  accept,
  onRunChanged,
}: {
  item: CheckItem;
  review: UseQueryResult<ReviewRun>;
  /** The run's record, for who may talk to its AI; undefined while it loads. */
  runInfo: Run | undefined;
  /** Why the chat isn't offered (`chatBlocked`); null when it is, undefined while loading. */
  blocked: string | null | undefined;
  /** The run's chat stream, held by the panel. */
  chat: RunChat;
  canAccept: boolean;
  example: boolean;
  /** Signed off in this panel. */
  accepted: boolean;
  accept: Accept;
  onRunChanged: () => void;
}) {
  const run = review.data;
  const task = run?.revisions.at(-1)?.tasks.find((t) => t.id === item.taskId);
  // A redo replaces the task's checks: then its first open one is this item's check.
  const check =
    task?.checks.find((c) => c.id === item.checkId) ??
    (item.checkId ? task?.checks.find((c) => c.status === "open") : undefined);
  const checkId = check?.id ?? item.checkId;
  const view = useMemo(
    () =>
      run && task
        ? taskScene(run, item.taskId, checkId, (sha256) =>
            new URL(reviewAssetUrl(item.runId, sha256, "x").slice(0, -1), location.href).toString(),
          )
        : undefined,
    [run, task, item, checkId],
  );
  // A run on its first pass has no results to talk about yet; a reopened one does.
  const firstPass = runInfo?.state.status !== "ended" && !chat.log.reopened;
  const talk = blocked === null && !firstPass;
  const [marking, setMarking] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const viewer = useRef<GridViewerHandle>(null);
  const gridMarks = useMemo(
    () => marks.map((m): GridMark => (m.point ? { point: m.point } : { box: m.box! })),
    [marks],
  );
  // A redo can move the item to another image: marks name the one they were made on.
  const imageId = view?.state === "ready" ? view.imageId : undefined;
  useEffect(() => setMarks((all) => all.filter((m) => m.volumeId === imageId)), [imageId]);

  // The region under check, when only its voxels say where it is; the grid's centre if it fails.
  const [located, setLocated] = useState<Zyx | null>();
  const locate = view?.state === "ready" ? view.locate : undefined;
  useEffect(() => {
    if (!locate) return;
    const abort = new AbortController();
    locate(abort.signal).then(
      (point) => setLocated(point ?? null),
      () => {
        if (!abort.signal.aborted) setLocated(null);
      },
    );
    return () => abort.abort();
  }, [locate]);

  const preparing =
    view?.state === "preparing" || view?.objects.some((o) => o.state === "preparing");
  const { refetch } = review;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void refetch(), PREPARING_POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, refetch]);

  let stage: ReactNode;
  if (review.isPending) stage = <Notice>Loading the run…</Notice>;
  // A reopened run's results are unavailable while it is corrected: keep showing the last ones.
  else if (review.isError && !run)
    stage = (
      <Notice alert action={<Button onClick={() => void refetch()}>Try again</Button>}>
        {loadError(review.error)}
      </Notice>
    );
  else if (!task) stage = <Notice>This task isn't in the run's latest results.</Notice>;
  else if (view?.state === "ready" && view.locate && located === undefined)
    stage = <Notice>Finding the region to check…</Notice>;
  else if (view?.state === "ready")
    stage = (
      // Remounts per item (the parent's key) and per image: the crosshair starts on its focus.
      <GridViewer
        key={view.imageId}
        ref={viewer}
        scene={view.scene}
        point={located ?? view.point}
        marking={marking}
        marks={gridMarks}
        onMark={(m) =>
          setMarks((all) => {
            const mark = { volumeId: view.imageId, ...m } as Mark;
            return all.some((a) => markLabel(a) === markLabel(mark))
              ? all
              : [...all, mark].slice(-MAX_MARKS);
          })
        }
      >
        {talk && (
          <span className="flex items-center gap-2">
            <Button size="sm" aria-pressed={marking} onClick={() => setMarking((m) => !m)}>
              {marking ? "Done marking" : "Mark"}
            </Button>
            {marking && <span>Click a slice for a point, drag for a box</span>}
          </span>
        )}
      </GridViewer>
    );
  else if (view?.state === "preparing")
    stage = <Notice>Preparing this scan for 3D. It opens here when it's ready.</Notice>;
  else if (view?.state === "failed")
    stage = <Notice alert>Couldn't prepare this scan for 3D: {view.error}</Notice>;
  else stage = <Notice>This task has no scan to show in 3D.</Notice>;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="flex h-[62dvh] shrink-0 flex-col bg-background md:h-auto md:min-w-0 md:flex-1">
        {stage}
      </div>
      {task && (
        <aside className="flex flex-col gap-6 border-border p-4 md:w-[360px] md:shrink-0 md:overflow-y-auto md:border-l">
          {item.checkId &&
            (check ? (
              <CheckCard
                title={check.title}
                detail={check.detail}
                action={
                  check.status === "accepted" || accepted ? (
                    <p className="flex items-center gap-1.5 text-ui font-medium text-primary-text">
                      <Check size={16} aria-hidden /> Looked right
                    </p>
                  ) : canAccept ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={accept.isPending}
                      onClick={() => accept.mutate({ item, revisionId: run!.review!.revisionId })}
                    >
                      {accept.isPending ? "Saving…" : "Looks right"}
                    </Button>
                  ) : (
                    <p className="text-meta text-muted-foreground">
                      {example
                        ? "Examples are read-only."
                        : runInfo?.state.status === "ended" && runInfo.state.outcome !== "completed"
                          ? "This run didn't finish, so nothing here can be marked as looked at."
                          : "You can sign off checks once the run has finished."}
                    </p>
                  )
                }
                error={accept.isError ? `Couldn't save: ${accept.error.message}` : undefined}
                open={check.status === "open" && !accepted}
              />
            ) : (
              <p className="text-ui text-muted-foreground">
                This check is no longer open in the run's latest results.
              </p>
            ))}
          <Values task={task} before={previousAttempt(run!, task)} />
          {view && view.objects.length > 0 && <InView objects={view.objects} />}
          {talk && runInfo && run ? (
            <Chat
              run={runInfo}
              review={run}
              taskId={item.taskId}
              marks={marks}
              onMarksSent={() => {
                setMarks([]);
                setMarking(false);
              }}
              removeMark={(i) => setMarks((all) => all.filter((_, j) => j !== i))}
              viewer={viewer}
              chat={chat}
              onRunChanged={onRunChanged}
            />
          ) : (
            (blocked || (blocked === null && firstPass)) && (
              <p className="text-ui text-muted-foreground">
                {blocked ?? "You can talk to the run's AI here once the run has finished."}
              </p>
            )
          )}
        </aside>
      )}
    </div>
  );
}

function loadError(error: Error) {
  if (error instanceof ApiError && error.status === 404)
    return "This run is unavailable or you don't have access to it.";
  if (error instanceof ApiError && error.status === 409) return "This run has no results yet.";
  return `Couldn't load the run: ${error.message}`;
}

function Notice({
  children,
  alert,
  action,
}: {
  children: ReactNode;
  alert?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ui text-muted-foreground"
    >
      <p className="max-w-sm">{children}</p>
      {action}
    </div>
  );
}

function CheckCard({
  title,
  detail,
  action,
  error,
  open,
}: {
  title: string;
  detail: string;
  action: ReactNode;
  error?: string;
  open: boolean;
}) {
  return (
    <article
      className={`flex flex-col gap-3 rounded-lg border p-3.5 ${open ? "border-check-line bg-check-tint" : "border-border"}`}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-ui font-semibold text-foreground">{title}</h3>
        {detail && <p className="text-ui text-foreground">{detail}</p>}
      </div>
      <div>{action}</div>
      {error && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * The task as its attempt before the latest one left it, when the latest came from a researcher's
 * correction. Revisions before the first go are the first pass's own (the lead AI redoing a task
 * opens one too), so a result from those has nothing to compare: a reopen comes only after the
 * first pass, and every revision from the first go on is a correction's.
 */
function previousAttempt(run: ReviewRun, task: ReviewTask): ReviewTask | undefined {
  const firstGo = run.revisions.findIndex((r) => r.id.endsWith(goMarkerId("")));
  const latest = run.revisions.findIndex((r) => r.id === task.resultRevisionId);
  if (firstGo === -1 || latest < firstGo) return undefined;
  for (const rev of [...run.revisions].reverse()) {
    const earlier = rev.tasks.find((t) => t.id === task.id);
    if (earlier && earlier.resultRevisionId !== task.resultRevisionId) return earlier;
  }
  return undefined;
}

function Values({ task, before }: { task: ReviewTask; before?: ReviewTask }) {
  const shown = (m: ReviewTask["measurements"][number]) =>
    m.value === null ? "Not supplied" : format(m.value);
  const rows = [
    ...task.measurements.map((m) => {
      const was = before?.measurements.find((b) => b.id === m.id);
      return {
        id: m.id,
        name: m.title ?? m.id,
        value: shown(m),
        unit: m.unit === "1" ? "" : m.unit,
        // Compared as shown: a change past the shown digits isn't one the reader can see.
        was: was && shown(was) !== shown(m) ? shown(was) : undefined,
      };
    }),
    ...task.scores.map((s) => {
      const was = before?.scores.find((b) => b.id === s.id);
      return {
        id: s.id,
        name: s.title ?? s.id,
        value: s.level,
        unit: "",
        was: was && was.level !== s.level ? was.level : undefined,
      };
    }),
  ];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-meta font-semibold text-muted-foreground">Values</h3>
      {rows.length === 0 ? (
        <p className="text-ui text-muted-foreground">This task reported no values.</p>
      ) : (
        <table className="w-full text-ui">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line-subtle last:border-0">
                <td className="py-1.5 pr-3 align-top">{row.name}</td>
                <td
                  className={`py-1.5 text-right align-top font-mono whitespace-nowrap tabular-nums ${row.was ? "text-info" : ""}`}
                >
                  {row.value}
                  {row.unit && <span className="ml-1 text-muted-foreground">{row.unit}</span>}
                  {row.was && (
                    <span className="block text-meta text-muted-foreground">was {row.was}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const STATE_WORDS: Record<SceneObject["state"], string> = {
  ready: "",
  preparing: "Preparing",
  failed: "Couldn't prepare",
  unsupported: "Not drawn yet",
};

function InView({ objects }: { objects: SceneObject[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-meta font-semibold text-muted-foreground">In the view</h3>
      <ul className="flex flex-col text-ui">
        {objects.map((o) => (
          <li key={o.id} className="flex items-center gap-2 py-1">
            <span
              aria-hidden
              className={`size-2.5 shrink-0 rounded-full ${o.underCheck ? "bg-check-outline" : "bg-line-strong"}`}
            />
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            {o.underCheck && <span className="sr-only">under check</span>}
            {o.state !== "ready" && (
              <span className="text-meta text-muted-foreground" title={o.error}>
                {STATE_WORDS[o.state]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

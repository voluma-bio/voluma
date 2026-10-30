/** Review layout consumes real result snapshots; opening images never invents analysis results. */

import { useMutation } from "@tanstack/react-query";
import { markReviewed } from "@voluma/api-client";
import type { Focus, Revision } from "@voluma/contracts/review";
import { StatusBadge } from "@voluma/ui";
import type { StructureDisplay } from "@voluma/viewer/grid";
import { ArrowLeft, Download, History, Layers, ListChecks } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { downloadCsv, downloadReviewReport } from "./export";
import { type ReviewRun, taskStatus } from "./model";
import { TaskReport } from "./TaskReport";

// three.js and the zarr reader load only once there is a task to show.
const TaskViewer = lazy(() => import("./TaskViewer").then((m) => ({ default: m.TaskViewer })));

export function ReviewWorkspace({
  runId,
  run,
  canReview = false,
  taskId,
  revisionId,
  navigate,
  backLink,
  notice,
  onRefresh,
}: {
  runId: string;
  run?: ReviewRun;
  canReview?: boolean;
  taskId?: string;
  revisionId?: string;
  navigate(selection: { task?: string; revision?: string }): void;
  backLink: ReactNode;
  /** Loading/unavailable state, or an actionable refresh failure above retained results. */
  notice?: ReactNode;
  onRefresh(): Promise<void>;
}) {
  const [tab, setTab] = useState<"tasks" | "structures">("tasks");
  const [display, setDisplay] = useState<StructureDisplay>({});
  const [filter, setFilter] = useState("");
  const report = useMutation({
    mutationFn: ({ run, revision }: { run: ReviewRun; revision: Revision }) =>
      downloadReviewReport(run, revision),
  });
  const [focusedCheck, setFocusedCheck] = useState<{
    revisionId: string;
    taskId: string;
    focus: Focus;
  }>();
  const latest = run?.revisions.at(-1);
  const revision = revisionId ? run?.revisions.find((item) => item.id === revisionId) : latest;
  const task = taskId ? revision?.tasks.find((item) => item.id === taskId) : revision?.tasks[0];
  const readOnly = !canReview || !run?.review || revision !== latest;
  const complete = useMutation({
    mutationFn: () => markReviewed(runId, { baseRevisionId: latest?.id ?? "" }),
    onSuccess: onRefresh,
    onError: onRefresh,
  });
  return (
    <div className="review-shell" data-theme="light">
      <div className="run-header">
        <div>
          <div className="back-link">
            <ArrowLeft size={14} />
            {backLink}
          </div>
          <div className="run-title">
            <h1 className="text-xl font-semibold">{run?.sample ?? runId}</h1>
            {run?.review && (
              <StatusBadge tone={run.review.remainingToCheck ? "check" : "primary"}>
                {run.review.reviewedAt
                  ? "Reviewed"
                  : run.review.remainingToCheck
                    ? `${run.review.remainingToCheck} to check`
                    : "Checked"}
              </StatusBadge>
            )}
          </div>
          {run && (
            <p className="text-sm text-muted-foreground">
              {run.workflows
                .map((w) =>
                  [w.path?.split("/").at(-1) ?? w.repo, w.commit?.slice(0, 7)]
                    .filter(Boolean)
                    .join(" · "),
                )
                .join(", ")}
            </p>
          )}
        </div>
        <div className="run-actions">
          {run?.review && !run.review.reviewedAt && (
            <button
              type="button"
              className="button primary"
              disabled={readOnly || run.review.remainingToCheck !== 0 || complete.isPending}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "Marking reviewed…" : "Mark reviewed"}
            </button>
          )}
          {run && revision && (
            <>
              <label className="revision-select">
                <History size={15} />
                <span className="sr-only">Revision</span>
                <select
                  aria-label="Revision"
                  value={revision.id}
                  onChange={(event) => navigate({ task: task?.id, revision: event.target.value })}
                >
                  {run.revisions.map((item, i) => (
                    <option key={item.id} value={item.id}>
                      R{i + 1} · {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="button" onClick={() => downloadCsv(run, revision)}>
                <Download size={15} />
                Export CSV
              </button>
              <button
                type="button"
                className="button"
                disabled={report.isPending}
                onClick={() => report.mutate({ run, revision })}
              >
                <Download size={15} />
                {report.isPending ? "Exporting report…" : "Export review report"}
              </button>
            </>
          )}
        </div>
      </div>
      {run && notice && (
        <div className="revision-notice" role="alert">
          {notice}
        </div>
      )}
      {complete.error && !run?.review?.reviewedAt && (
        <p className="error-message" role="alert">
          {complete.error.message}
        </p>
      )}
      {report.error && (
        <p className="error-message" role="alert">
          Could not export the review report. Check your connection and try again.
        </p>
      )}
      {revision && revision !== latest && (
        <div className="revision-notice">Earlier results are read-only.</div>
      )}
      <main className="review-body">
        <aside className="task-sidebar">
          <div className="sidebar-tabs">
            <button type="button" aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>
              <ListChecks size={16} />
              Tasks
            </button>
            <button
              type="button"
              aria-pressed={tab === "structures"}
              onClick={() => setTab("structures")}
            >
              <Layers size={16} />
              Structures
            </button>
          </div>
          <div className="sidebar-scroll">
            {tab === "tasks" ? (
              <>
                <p className="sidebar-label">
                  Workflow tasks <span>{revision?.tasks.length ?? 0}</span>
                </p>
                <nav aria-label="Workflow tasks">
                  {revision?.tasks.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`task-nav ${item === task ? "selected" : ""}`}
                      aria-current={item === task ? "step" : undefined}
                      onClick={() => navigate({ task: item.id, revision: revisionId })}
                    >
                      <span className="task-number">{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        {item.title}
                        <span className="task-meta">
                          <StatusBadge tone={taskStatus(item).tone}>
                            {taskStatus(item).label}
                          </StatusBadge>
                          {item.status !== "pending" && (
                            <>
                              {" "}
                              {item.checks.filter((check) => check.status === "open").length} to
                              check
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </nav>
                {!revision?.tasks.length && (
                  <p className="px-5 text-sm text-muted-foreground" role="status">
                    {notice ?? "Tasks appear when an analysis result is connected."}
                  </p>
                )}
              </>
            ) : (
              <div className="structures-list">
                <label className="sr-only" htmlFor="structure-filter">
                  Find a structure
                </label>
                <input
                  id="structure-filter"
                  className="text-input"
                  placeholder="Find a structure…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                {[
                  ...(revision?.structures ?? []).map((item) => ({
                    id: item.id,
                    name: item.name,
                    label: item.voxels && "label" in item.voxels ? item.voxels.label : undefined,
                    note: item.missing ? `Missing · ${item.missing.reason}` : "Reported",
                  })),
                  // Surfaces draw as meshes in 3D, so they hide and fade the same way.
                  ...(revision?.surfaces ?? []).map((item) => ({
                    id: item.id,
                    name: item.name,
                    label: undefined,
                    note: "Surface",
                  })),
                ]
                  .filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()))
                  .map((item) => {
                    const settings = display[item.id] ?? { visible: true, opacity: 100 };
                    return (
                      <div className="structure-row" key={item.id}>
                        <label className="flex gap-2">
                          <input
                            type="checkbox"
                            checked={settings.visible}
                            onChange={(event) =>
                              setDisplay({
                                ...display,
                                [item.id]: { ...settings, visible: event.target.checked },
                              })
                            }
                          />
                          {item.label !== undefined && (
                            <span
                              className="inline-block h-2 w-2 self-center"
                              style={{
                                background: `var(--label-${((item.label - 1) % 12) + 1})`,
                              }}
                            />
                          )}
                          {item.name}
                        </label>
                        <p className="mt-2 text-muted-foreground">{item.note}</p>
                        <label className="opacity-control">
                          Opacity
                          <input
                            type="range"
                            aria-label={`${item.name} opacity`}
                            min={0}
                            max={100}
                            value={settings.opacity}
                            disabled={!settings.visible}
                            onChange={(event) =>
                              setDisplay({
                                ...display,
                                [item.id]: { ...settings, opacity: Number(event.target.value) },
                              })
                            }
                          />
                          <output>{settings.opacity}%</output>
                        </label>
                      </div>
                    );
                  })}
                {!revision?.structures.length && !revision?.surfaces.length && (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No structures or surfaces are available.
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
        <div className="review-panels">
          <Group orientation="horizontal" id="review-split">
            <Panel id="report" defaultSize="42%" minSize="28%">
              <div className="report-scroll" key={`${revision?.id}-${task?.id}`}>
                {task && revision && run ? (
                  <TaskReport
                    task={task}
                    blockName={(id) =>
                      [
                        ...revision.volumes,
                        ...revision.structures,
                        ...revision.surfaces,
                        ...revision.annotations,
                      ].find((item) => item.id === id)?.name ?? id
                    }
                    resultLabel={`R${run.revisions.findIndex((item) => item.id === task.resultRevisionId) + 1}`}
                    taskNumber={revision.tasks.indexOf(task) + 1}
                    runId={run.id}
                    revisionId={revision.id}
                    readOnly={readOnly}
                    onFocus={(focus) =>
                      setFocusedCheck(
                        focus ? { revisionId: revision.id, taskId: task.id, focus } : undefined,
                      )
                    }
                    onRefresh={onRefresh}
                  />
                ) : (
                  <article className="task-report">
                    <p className="text-xs text-muted-foreground">Task report</p>
                    <h2 className="text-xl font-semibold mt-3">
                      {run ? "Result not available" : "No analysis results yet"}
                    </h2>
                    <p className="text-muted-foreground mt-4 leading-relaxed">
                      {run
                        ? "This task or revision does not exist."
                        : notice
                          ? notice
                          : "Measurements, checks, evidence and images appear only after an analysis has produced them."}
                    </p>
                    <section>
                      <h3 className="font-medium">Measurements</h3>
                      <p className="text-sm text-muted-foreground mt-2">
                        No measurements supplied.
                      </p>
                    </section>
                    <section>
                      <h3 className="font-medium">To check</h3>
                      <p className="text-sm text-muted-foreground mt-2">
                        No review decisions are available.
                      </p>
                    </section>
                    <section>
                      <h3 className="font-medium">Evidence</h3>
                      <p className="text-sm text-muted-foreground mt-2">
                        No analysis evidence is attached.
                      </p>
                    </section>
                  </article>
                )}
              </div>
            </Panel>
            <Separator
              className="resize-handle main-handle"
              aria-label="Resize report and viewers"
            />
            <Panel id="imaging" minSize="28%">
              {run && revision && task ? (
                <Suspense>
                  <TaskViewer
                    runId={run.id}
                    revision={revision}
                    task={task}
                    assets={run.assets}
                    display={display}
                    focus={
                      focusedCheck &&
                      focusedCheck.revisionId === revision.id &&
                      focusedCheck.taskId === task.id
                        ? focusedCheck.focus
                        : undefined
                    }
                  />
                </Suspense>
              ) : (
                <section className="viewer-workspace" aria-label="Imaging workspace">
                  <div className="view-empty" role="status">
                    Images appear with the task's results.
                  </div>
                </section>
              )}
            </Panel>
          </Group>
        </div>
      </main>
      <footer className="app-footer">
        <span>Research review</span>
        <span>Display settings do not change scientific results</span>
      </footer>
    </div>
  );
}

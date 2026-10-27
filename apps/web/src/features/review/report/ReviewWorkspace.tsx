/** Review layout consumes real result snapshots; opening images never invents analysis results. */

import type { StructureDisplay } from "@voluma/viewer";
import { ArrowLeft, Download, History, Layers, ListChecks } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { CorrectionDialog } from "./CorrectionDialog";
import { downloadCsv } from "./export";
import type { ReviewRun, ReviewTask } from "./model";
import type { ReviewService } from "./service";
import { TaskReport } from "./TaskReport";

export function ReviewWorkspace({
  runId,
  run,
  service,
  taskId,
  revisionId,
  navigate,
  backLink,
  viewer,
  intake,
  onResult,
}: {
  runId: string;
  run?: ReviewRun;
  service?: ReviewService;
  taskId?: string;
  revisionId?: string;
  navigate(selection: { task?: string; revision?: string }): void;
  backLink: ReactNode;
  viewer: (selected: { id: string; name: string }[], display: StructureDisplay) => ReactNode;
  intake?: ReactNode;
  onResult(run: ReviewRun): void;
}) {
  const [tab, setTab] = useState<"tasks" | "structures">("tasks");
  const [display, setDisplay] = useState<StructureDisplay>({});
  const [filter, setFilter] = useState("");
  const [correction, setCorrection] = useState<{
    task: ReviewTask;
    text: string;
    focus: HTMLElement | null;
  } | null>(null);
  const latest = run?.revisions.at(-1);
  const revision = revisionId ? run?.revisions.find((item) => item.id === revisionId) : latest;
  const task = taskId ? revision?.tasks.find((item) => item.id === taskId) : revision?.tasks[0];
  const readOnly = !service || revision !== latest;
  const selected =
    revision?.structures.filter((item) => task?.structureIds.includes(item.id)) ?? [];
  return (
    <div className="review-shell" data-theme="light">
      <header className="app-header">
        <div className="brand">
          <Layers size={23} />
          <span>voluma</span>
        </div>
        <span className="header-divider" />
        <span className="text-fg-muted">Review</span>
        <span className="ml-auto text-xs text-fg-muted">
          {run ? "Analysis results" : "No analysis results"}
        </span>
      </header>
      <div className="run-header">
        <div>
          <div className="back-link">
            <ArrowLeft size={14} />
            {backLink}
          </div>
          <h1 className="text-xl font-semibold mt-2">
            {run?.sample ?? (runId === "local" ? "Local scan" : runId)}
          </h1>
          {run && (
            <p className="text-sm text-fg-muted">
              {run.workflow} · v{run.workflowVersion}
            </p>
          )}
        </div>
        <div className="run-actions">
          {intake}
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
                  {run.revisions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id.toUpperCase()} · {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="button" onClick={() => downloadCsv(run, revision)}>
                <Download size={15} />
                Export CSV
              </button>
            </>
          )}
        </div>
      </div>
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
                          {item.checks.filter((check) => check.status === "open").length} to check
                        </span>
                      </span>
                    </button>
                  ))}
                </nav>
                {!revision?.tasks.length && (
                  <p className="px-5 text-sm text-fg-muted">
                    Tasks appear when an analysis result is connected.
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
                {revision?.structures
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
                          {item.name}
                        </label>
                        <p className="mt-2 text-fg-muted">
                          {item.status} · {item.reason}
                        </p>
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
                {!revision?.structures.length && (
                  <p className="mt-4 text-sm text-fg-muted">
                    No segmentation structures are available.
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
                    taskNumber={revision.tasks.indexOf(task) + 1}
                    runId={run.id}
                    revisionId={revision.id}
                    readOnly={readOnly}
                    service={service}
                    onResult={onResult}
                    onCorrect={(text) =>
                      setCorrection({
                        task,
                        text,
                        focus:
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null,
                      })
                    }
                  />
                ) : (
                  <article className="task-report">
                    <p className="text-xs text-fg-muted">Task report</p>
                    <h2 className="text-xl font-semibold mt-3">
                      {run ? "Result not available" : "No analysis results yet"}
                    </h2>
                    <p className="text-fg-muted mt-4 leading-relaxed">
                      {run
                        ? "This task or revision does not exist."
                        : "Opening a scan displays its images. Measurements, checks and evidence appear only after an analysis has produced them."}
                    </p>
                    <section>
                      <h3 className="font-medium">Measurements</h3>
                      <p className="text-sm text-fg-muted mt-2">No measurements supplied.</p>
                    </section>
                    <section>
                      <h3 className="font-medium">To check</h3>
                      <p className="text-sm text-fg-muted mt-2">
                        No review decisions are available.
                      </p>
                    </section>
                    <section>
                      <h3 className="font-medium">Evidence</h3>
                      <p className="text-sm text-fg-muted mt-2">
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
              {viewer(selected, display)}
            </Panel>
          </Group>
        </div>
      </main>
      <footer className="app-footer">
        <span>Research review</span>
        <span>Display settings do not change scientific results</span>
      </footer>
      {correction && revision && run && service && (
        <CorrectionDialog
          service={service}
          runId={run.id}
          revisionId={revision.id}
          task={correction.task}
          tasks={revision.tasks}
          initialText={correction.text}
          returnFocus={correction.focus}
          onClose={() => setCorrection(null)}
          onResult={(updated) => {
            onResult(updated);
            setCorrection(null);
            navigate({ task: correction.task.id });
          }}
        />
      )}
    </div>
  );
}

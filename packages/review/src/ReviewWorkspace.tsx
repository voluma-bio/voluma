/** Review orchestration: query-owned results, URL-owned selection, local display preferences. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReviewRun, ReviewTask } from "@voluma/contracts";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  FlaskConical,
  History,
  Layers,
  ListChecks,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { CorrectionDialog } from "./CorrectionDialog";
import { downloadCsv } from "./export";
import type { DemoControls, ReviewService } from "./service";
import { TaskReport } from "./TaskReport";
import { type StructureDisplay, ViewerWorkspace } from "./ViewerWorkspace";

export function ReviewWorkspace({
  runId,
  taskId,
  revisionId,
  navigate,
  backLink,
  service,
  demoControls,
}: {
  runId: string;
  taskId?: string;
  revisionId?: string;
  navigate(selection: { task: string; revision?: string }): void;
  backLink: ReactNode;
  service: ReviewService;
  demoControls: DemoControls;
}) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["review", runId],
    queryFn: () => service.getRun(runId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [tab, setTab] = useState<"tasks" | "structures">("tasks");
  const [display, setDisplay] = useState<StructureDisplay>({});
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");
  const [armed, setArmed] = useState(false);
  const [correction, setCorrection] = useState<{
    task: ReviewTask;
    revisionId: string;
    text: string;
    focus: HTMLElement | null;
  } | null>(null);
  const update = (run: ReviewRun) => cache.setQueryData(["review", runId], run);

  if (query.isPending)
    return (
      <main className="load-state">
        <FlaskConical size={28} />
        <h1>Loading review</h1>
        <p role="status">Retrieving the demo run…</p>
      </main>
    );
  if (query.isError)
    return (
      <main className="load-state">
        <h1>Review unavailable</h1>
        <p role="alert">{query.error.message}</p>
        <button
          type="button"
          className="button primary"
          onClick={() => void query.refetch()}
        >
          Retry loading
        </button>
        {backLink}
      </main>
    );
  const run = query.data;
  const latest = run.revisions[run.revisions.length - 1];
  const revision = revisionId
    ? run.revisions.find((r) => r.id === revisionId)
    : latest;
  const task = revision?.tasks.find((t) => t.id === (taskId || "femur"));
  if (!revision || !task)
    return (
      <main className="load-state">
        <h1>Result not available</h1>
        <p>
          This task or revision does not exist in this demo session. Reloading
          resets simulated revisions.
        </p>
        <button
          type="button"
          className="button primary"
          onClick={() => navigate({ task: "femur" })}
        >
          Open latest result
        </button>
        {backLink}
      </main>
    );
  const readOnly = revision.id !== latest.id;
  const openChecks = revision.tasks.reduce(
    (sum, t) => sum + t.checks.filter((c) => c.status === "open").length,
    0,
  );
  const selectedStructures = revision.structures.filter((s) =>
    task.structureIds.includes(s.id),
  );
  const openCorrection = (text: string) =>
    setCorrection({
      task,
      revisionId: revision.id,
      text,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });

  return (
    <div className="review-shell">
      <header className="app-header">
        <div className="brand">
          <Layers size={23} strokeWidth={1.7} />
          <span>voluma</span>
        </div>
        <span className="header-divider" />
        <span className="text-muted-foreground">Review</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="demo-label">Demo workspace</span>
          <Dialog.Root>
            <Dialog.Trigger className="button compact">
              <FlaskConical size={15} />
              Demo controls
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content">
                <Dialog.Title className="text-xl font-semibold">
                  Demo controls
                </Dialog.Title>
                <Dialog.Description className="text-muted-foreground mt-3">
                  Results come from an in-memory fixture. Questions are
                  scripted; reruns do not call an agent. Reloading resets all
                  changes.
                </Dialog.Description>
                <div className="space-y-3 my-6">
                  <button
                    type="button"
                    className="button"
                    disabled={armed}
                    onClick={() => {
                      demoControls.failNextRerun();
                      setArmed(true);
                    }}
                  >
                    {armed ? "Next rerun will fail once" : "Fail next rerun"}
                  </button>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        demoControls.failNextLoad();
                        void query.refetch();
                      }}
                    >
                      Simulate load error
                    </button>
                  </Dialog.Close>
                </div>
                <p className="text-sm text-muted-foreground">
                  Try a correction on Trabecular IIOC to see Plate thickness
                  rerun too. Unrelated tasks retain their earlier results.
                </p>
                <div className="flex justify-end mt-6">
                  <Dialog.Close className="button">Close controls</Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </header>
      <div className="run-header">
        <div>
          <div className="back-link">
            <ArrowLeft size={14} />
            {backLink}
          </div>
          <div className="flex items-baseline gap-3 mt-2">
            <h2 className="text-xl font-semibold">{run.sample}</h2>
            <span className="text-sm text-muted-foreground">
              {run.workflow}
              <span className="ml-2 font-mono">v{run.workflowVersion}</span>
            </span>
          </div>
        </div>
        <div className="run-actions">
          <span className={`badge ${openChecks ? "warning" : ""}`}>
            {openChecks ? `${openChecks} to check` : "All checks accepted"}
          </span>
          <label className="revision-select">
            <History size={15} />
            <span className="sr-only">Revision</span>
            <select
              aria-label="Revision"
              value={revision.id}
              onChange={(e) => {
                setNotice("");
                navigate({ task: task.id, revision: e.target.value });
              }}
            >
              {run.revisions.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.id.toUpperCase()} · {r.label}
                  {r.id === latest.id ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            onClick={() => downloadCsv(run, revision)}
          >
            <Download size={15} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>
      <div className="demo-banner">
        Demo fixture · not for scientific use. Reference files are not bundled;
        simulated values are labeled.
      </div>
      {(notice || readOnly) && (
        <div className="revision-notice" role="status">
          {readOnly
            ? `Viewing ${revision.id.toUpperCase()}. Earlier results are read-only.`
            : notice}
          {readOnly && (
            <button
              type="button"
              className="text-button"
              onClick={() => navigate({ task: task.id })}
            >
              Return to latest
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
      <main className="review-body">
        <aside className="task-sidebar">
          <div className="sidebar-tabs">
            <button
              type="button"
              aria-pressed={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
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
                  Workflow tasks <span>{revision.tasks.length}</span>
                </p>
                <nav aria-label="Workflow tasks">
                  {revision.tasks.map((t, index) => {
                    const count = t.checks.filter(
                      (c) => c.status === "open",
                    ).length;
                    return (
                      <button
                        type="button"
                        className={`task-nav ${t.id === task.id ? "selected" : ""}`}
                        aria-current={t.id === task.id ? "step" : undefined}
                        key={t.id}
                        onClick={() => {
                          setNotice("");
                          navigate({ task: t.id, revision: revisionId });
                        }}
                      >
                        <span className="task-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>
                          <span className="block font-medium">{t.title}</span>
                          <span className="task-meta">
                            {count ? `${count} to check` : "Checks accepted"}
                          </span>
                        </span>
                        {count === 0 ? (
                          <Check size={14} className="ml-auto text-primary" />
                        ) : (
                          <span className="check-dot" />
                        )}
                      </button>
                    );
                  })}
                </nav>
                <div className="sidebar-note">
                  <Check size={16} className="text-primary mb-2" />
                  <p>
                    All five tasks finished in the reference fixture. Review
                    decisions are separate from execution status.
                  </p>
                </div>
              </>
            ) : (
              <div className="structures-list">
                <label htmlFor="structure-filter" className="sr-only">
                  Find a structure
                </label>
                <input
                  id="structure-filter"
                  className="text-input"
                  placeholder="Find a structure…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <p className="text-xs text-muted-foreground my-3">
                  18 reference structures. Controls change local display
                  settings only; no meshes are loaded.
                </p>
                {revision.structures
                  .filter((s) =>
                    s.name.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((s) => {
                    const settings = display[s.id] || {
                      visible: true,
                      opacity: 100,
                    };
                    return (
                      <div className="structure-row" key={s.id}>
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={settings.visible}
                            onChange={(e) =>
                              setDisplay({
                                ...display,
                                [s.id]: {
                                  ...settings,
                                  visible: e.target.checked,
                                },
                              })
                            }
                          />
                          <span className="font-medium">{s.name}</span>
                        </label>
                        <p className="text-xs text-muted-foreground mt-2">
                          {s.status}
                          {!s.declared && " · Undeclared"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {s.reason}
                        </p>
                        <label className="opacity-control">
                          Opacity
                          <input
                            type="range"
                            aria-label={`${s.name} opacity`}
                            min="0"
                            max="100"
                            value={settings.opacity}
                            disabled={!settings.visible}
                            onChange={(e) =>
                              setDisplay({
                                ...display,
                                [s.id]: {
                                  ...settings,
                                  opacity: Number(e.target.value),
                                },
                              })
                            }
                          />
                          <output>{settings.opacity}%</output>
                        </label>
                      </div>
                    );
                  })}
                {!revision.structures.some((s) =>
                  s.name.toLowerCase().includes(filter.toLowerCase()),
                ) && <p className="notice">No matching structures.</p>}
              </div>
            )}
          </div>
          <Dialog.Root>
            <Dialog.Trigger className="record-button">
              <History size={16} />
              Demo run record
              <ChevronRight size={14} className="ml-auto" />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content">
                <Dialog.Title className="text-xl font-semibold">
                  Demo run record
                </Dialog.Title>
                <Dialog.Description className="text-muted-foreground mt-2">
                  Session-only history of questions, accepted checks, and
                  confirmed corrections.
                </Dialog.Description>
                <ol className="record-list">
                  {run.record.map((entry) => (
                    <li key={entry.id}>
                      <span className="text-xs font-mono text-muted-foreground">
                        {entry.revisionId.toUpperCase()}{" "}
                        {entry.taskId && `/ ${entry.taskId}`}
                      </span>
                      <p className="mt-1">{entry.text}</p>
                    </li>
                  ))}
                </ol>
                <div className="flex justify-end">
                  <Dialog.Close className="button">Close record</Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </aside>
        <div className="review-panels">
          <Group orientation="horizontal" id="review-split">
            <Panel id="report" defaultSize="48%" minSize="32%">
              <div className="report-scroll" key={`${revision.id}-${task.id}`}>
                <TaskReport
                  task={task}
                  taskNumber={revision.tasks.indexOf(task) + 1}
                  runId={run.id}
                  revisionId={revision.id}
                  readOnly={readOnly}
                  service={service}
                  onResult={update}
                  onCorrect={openCorrection}
                />
              </div>
            </Panel>
            <Separator
              className="resize-handle main-handle"
              aria-label="Resize report and viewers"
            />
            <Panel id="imaging" minSize="24%">
              <ViewerWorkspace
                selected={selectedStructures}
                display={display}
              />
            </Panel>
          </Group>
        </div>
      </main>
      <footer className="app-footer">
        <span>Mouse knee morphometry</span>
        <span>Original-grid units · evidence-linked results</span>
      </footer>
      {correction && (
        <CorrectionDialog
          service={service}
          runId={run.id}
          revisionId={correction.revisionId}
          task={correction.task}
          tasks={revision.tasks}
          initialText={correction.text}
          returnFocus={correction.focus}
          onClose={() => {
            setCorrection(null);
            void query.refetch();
          }}
          onResult={(updated) => {
            update(updated);
            setCorrection(null);
            setNotice(
              "Simulated revision created. Affected results are synthetic and need review.",
            );
            navigate({ task: correction.task.id });
          }}
          onAttempt={() => setArmed(false)}
        />
      )}
    </div>
  );
}

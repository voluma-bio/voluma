/**
 * Report: the scan's task graph (report size), then the task in view: where it stands, what the
 * AI was asked, its items, its values, how they compare with reference readers, its QC images
 * and its files. Picking a box sets up the views on that task; a box's agent opens its steps.
 */
import { reviewFileUrl } from "@voluma/api-client";
import type { ReviewTask } from "@voluma/contracts/review";
import {
  formatDuration,
  type NeedItem,
  TASK_STATUS,
  TaskGraph,
  type TaskView,
  taskStateWord,
  useNow,
} from "@voluma/run-view";
import { EmptyState, List, Readout, Row, StatusGlyph, StatusMark, Table } from "@voluma/ui";
import { Download, FileText } from "lucide-react";
import { Evidence } from "./to-check-panel";

const isImage = (name: string) => /\.(jpe?g|png)$/i.test(name);

export function ReportPanel({
  runId,
  tasks,
  task,
  reviewTask,
  items,
  onTask,
  onItem,
  onAgent,
}: {
  runId: string;
  tasks: TaskView[];
  /** The task in view. */
  task: TaskView | undefined;
  /** Its review data (values, references, files), once the run has some. */
  reviewTask: ReviewTask | undefined;
  /** Every item of the scan, with what was accepted here. */
  items: NeedItem[];
  onTask: (taskId: string) => void;
  onItem: (item: NeedItem) => void;
  onAgent: (threadId: string) => void;
}) {
  if (tasks.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="No tasks yet">The tasks appear once the AI has planned them.</EmptyState>
      </div>
    );
  return (
    <div className="grid gap-5 p-4">
      <section aria-label="Tasks">
        <h3 className="mb-3 text-sm font-semibold">Tasks</h3>
        <TaskGraph
          size="report"
          tasks={tasks.map((t) => ({
            ...t,
            needs: t.needs.map((n) => items.find((i) => i.id === n.id) ?? n),
          }))}
          selected={task?.id}
          onSelect={onTask}
          onAgent={onAgent}
        />
      </section>
      {task && (
        <TaskDetail
          runId={runId}
          task={task}
          reviewTask={reviewTask}
          items={items.filter((n) => n.taskId === task.id)}
          titleOf={(id) => tasks.find((t) => t.id === id)?.title ?? id}
          onItem={onItem}
        />
      )}
    </div>
  );
}

/** Working time of a task's agents, together. */
function took(task: TaskView, now: number): string | undefined {
  if (task.threads.length === 0) return undefined;
  const seconds = task.threads.reduce((sum, t) => {
    const end = t.endedAt ? Date.parse(t.endedAt) : now;
    return sum + t.workedBefore + Math.max(0, end - Date.parse(t.startedAt)) / 1000;
  }, 0);
  return formatDuration(seconds);
}

function TaskDetail({
  runId,
  task,
  reviewTask,
  items,
  titleOf,
  onItem,
}: {
  runId: string;
  task: TaskView;
  reviewTask: ReviewTask | undefined;
  items: NeedItem[];
  titleOf: (taskId: string) => string;
  onItem: (item: NeedItem) => void;
}) {
  const open = items.filter((n) => !n.accepted).length;
  const working = task.state === "running" || task.state === "checking";
  const time = took(task, useNow(working));
  const references =
    reviewTask?.measurements.flatMap((m) => m.references.map((reference) => ({ m, reference }))) ??
    [];
  const evidence = reviewTask?.evidence ?? [];
  const images = evidence.filter((a) => isImage(a.name));
  const files = [...(reviewTask?.files ?? []), ...evidence.filter((a) => !isImage(a.name))];
  return (
    <article aria-label={`${task.title} report`} className="grid gap-4 border-t border-border pt-4">
      <header className="grid gap-1.5">
        <h3 className="text-base font-semibold">{task.title}</h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {open > 0 ? (
            <StatusMark status="check" label={`${open} to check`} />
          ) : (
            <StatusMark
              status={task.state === "to-check" ? "done" : TASK_STATUS[task.state]}
              label={task.state === "to-check" ? "Done" : taskStateWord(task.state)}
            />
          )}
          {time && <span>{working ? `${time} so far` : `Took ${time}`}</span>}
          {task.check && (
            <span>
              {task.check.verdict === "passed"
                ? "Second AI check agreed"
                : "Second AI check sent it back"}
            </span>
          )}
        </p>
        {reviewTask?.ask && (
          <p className="text-sm leading-relaxed">
            <span className="text-muted-foreground">Asked: </span>
            {reviewTask.ask}
          </p>
        )}
        {task.dependsOn.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Uses {task.dependsOn.map(titleOf).join(", ")}.
          </p>
        )}
        {task.reason && <p className="text-sm text-destructive">{task.reason}</p>}
        {task.did && <p className="text-sm leading-relaxed">{task.did}</p>}
      </header>

      {items.length > 0 && (
        <List boxed label="Items to check" columns="auto">
          {items.map((n) => (
            <Row
              key={n.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <StatusGlyph status={n.accepted ? "done" : "check"} />
                  <span className="truncate">{n.title ?? task.title}</span>
                </span>
              }
              cells={[
                <span key="state" className="text-xs text-muted-foreground">
                  {n.accepted ? "Looked right" : "Open"}
                </span>,
              ]}
              onSelect={() => onItem(n)}
            />
          ))}
        </List>
      )}

      {task.results.length > 0 && (
        <section aria-label="Values" className="grid gap-1.5">
          <h4 className="text-xs text-muted-foreground">Values</h4>
          <Readout
            values={task.results.map((r) => ({
              label: r.note ? (
                <span title={r.note}>
                  {r.title}
                  <span className="block truncate text-xs text-fg-subtle">{r.note}</span>
                </span>
              ) : (
                r.title
              ),
              value: r.value ?? "Not reported",
              unit: r.value === null ? undefined : r.unit,
            }))}
          />
        </section>
      )}

      {references.length > 0 && (
        <section aria-label="Against reference readers" className="grid gap-1.5">
          <h4 className="text-xs text-muted-foreground">Against reference readers</h4>
          <Table
            label="Against reference readers"
            density="compact"
            rows={references}
            rowKey={({ m, reference }) => `${m.id}-${reference.reader}`}
            columns={[
              {
                key: "value",
                header: "Value / reader",
                cell: ({ m, reference }) => (
                  <>
                    {m.title ?? m.id}
                    <span className="block text-xs text-fg-subtle">{reference.reader}</span>
                  </>
                ),
              },
              {
                key: "reference",
                header: "Reference",
                align: "end",
                cell: ({ m, reference }) => (
                  <span className="font-mono">
                    {reference.value.toFixed(3)}{" "}
                    <span className="text-xs text-fg-subtle">{m.unit}</span>
                  </span>
                ),
              },
              {
                key: "difference",
                header: "Difference",
                align: "end",
                cell: ({ m, reference }) => (
                  <span className="font-mono">
                    {m.value !== null && reference.value !== 0
                      ? `${((m.value / reference.value - 1) * 100).toFixed(1)}%`
                      : "Not reported"}
                  </span>
                ),
              },
            ]}
          />
        </section>
      )}

      {images.length > 0 && (
        <section aria-label="QC images" className="grid gap-1.5">
          <h4 className="text-xs text-muted-foreground">QC images</h4>
          <div className="grid grid-cols-2 gap-2">
            {images.map((a) => (
              <Evidence key={a.id} runId={runId} name={a.name} sha256={a.sha256} />
            ))}
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section aria-label="Files" className="grid gap-1.5">
          <h4 className="text-xs text-muted-foreground">Files</h4>
          <ul className="grid">
            {files.map((a) => (
              <li key={a.id}>
                <a
                  href={reviewFileUrl(runId, a.sha256)}
                  download={a.name.split("/").at(-1)}
                  className="flex items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent"
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <Download className="size-3.5 shrink-0 text-primary-text" aria-hidden />
                  <span className="sr-only">Download</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

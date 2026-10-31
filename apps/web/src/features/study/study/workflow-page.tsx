/**
 * The study's workflow, expanded (`/studies/:id/workflow`, the dashboard graph's Expand): the
 * TaskGraph at study size with room to read, and the selected task (`?task=`) on every scan
 * below it, each scan with its state there and a way into its review.
 */
import { itemHref, plural, scanLabel, TaskGraph, taskStateWord } from "@voluma/run-view";
import { Button, IconButton, List, PageHead, RowLink, STATUS_WORD, StatusMark } from "@voluma/ui";
import { Box as Cube, X } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { linkTo } from "../link";
import { useStudy } from "./study-layout";
import { cellOf, checkTitles, scanHref, stoppedLine, studyGraph, taskState } from "./study-model";

export function WorkflowPage() {
  const { detail, workflow } = useStudy();
  const [search, setSearch] = useSearchParams();
  const graph = studyGraph(detail, workflow);
  const selected = graph.find((t) => t.id === search.get("task"));
  return (
    <>
      <PageHead
        title={`Workflow, across ${plural(detail.scans.length, "scan")}`}
        subtitle={workflow.name}
      />
      <div className="border-b border-border px-6 py-6">
        <TaskGraph
          size="study"
          tasks={graph}
          selected={selected?.id}
          onSelect={(task) =>
            setSearch(task === selected?.id ? {} : { task }, {
              replace: true,
              preventScrollReset: true,
            })
          }
        />
      </div>
      {selected && (
        <section aria-labelledby="task-scans">
          <header className="flex h-(--panel-head-h) items-center gap-3 px-4">
            <h2 id="task-scans" className="m-0 text-sm font-semibold">
              {selected.title}
            </h2>
            <span className="text-sm text-muted-foreground">
              {(["check", "running", "checking", "stopped", "paused", "done", "waiting"] as const)
                .map((s) => [s, selected.scans.filter((x) => x === s).length] as const)
                .filter(([, n]) => n > 0)
                .map(([s, n]) => `${n} ${STATUS_WORD[s].toLowerCase()}`)
                .join(", ")}
            </span>
            <IconButton
              label="Close"
              className="ml-auto"
              onClick={() => setSearch({}, { replace: true, preventScrollReset: true })}
            >
              <X />
            </IconButton>
          </header>
          <List columns="auto auto" label={`${selected.title} on each scan`}>
            {detail.scans.flatMap((scan) => {
              const href = scanHref(scan);
              if (!href) return [];
              const { status, open } = cellOf(scan, selected.id);
              const items = scan.toCheck.filter((i) => i.taskId === selected.id);
              // The task's first item when it has one, so the review opens on it.
              const to = items[0] ? itemHref(items[0]) : href;

              return [
                <RowLink
                  key={scan.scan.inputId}
                  to={linkTo(to)}
                  title={scanLabel(scan.scan)}
                  subtitle={
                    items.length > 0
                      ? checkTitles(items)
                      : status === "stopped"
                        ? stoppedLine(scan, workflow)
                        : undefined
                  }
                  cells={[
                    <StatusMark
                      key="s"
                      status={status}
                      label={
                        status === "check"
                          ? `${open} to check`
                          : status === "stopped"
                            ? taskStateWord(taskState(scan, selected.id))
                            : undefined
                      }
                    />,
                    <Button key="3d" asChild size="sm">
                      <Link to={to}>
                        <Cube aria-hidden />
                        Review in 3D
                      </Link>
                    </Button>,
                  ]}
                />,
              ];
            })}
          </List>
        </section>
      )}
    </>
  );
}

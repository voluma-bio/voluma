/** The runs list (`/runs`): one row per run with its status, time and cost; a row opens the live run, or the review once the run is completed. */
import { useQuery } from "@tanstack/react-query";
import { listRuns } from "@voluma/api-client";
import type { Run } from "@voluma/contracts/run";
import { Button, Table } from "@voluma/ui";
import { useNavigate } from "react-router";
import {
  formatDuration,
  formatTime,
  formatUsd,
  RunBadge,
  runHref,
  runSeconds,
  runStatus,
} from "./status";
import { workflowName } from "./workflows";

function finished(run: Run): string {
  const { state } = run;
  if (state.status === "ended") return formatTime(state.endedAt);
  if (state.status === "running") return "In progress";
  return "Not started";
}

export function RunsPage() {
  const navigate = useNavigate();
  const runs = useQuery({ queryKey: ["runs"], queryFn: listRuns, refetchInterval: 5000 });

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-10 py-8 max-[1100px]:px-5">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-5 text-2xl font-semibold">Runs</h1>
        {runs.isError && (
          <p role="alert" className="mb-3 text-ui text-destructive">
            Couldn't load runs.{" "}
            <Button variant="ghost" size="sm" onClick={() => void runs.refetch()}>
              Try again
            </Button>
          </p>
        )}
        {runs.isPending ? (
          <p className="text-ui text-muted-foreground">Loading runs…</p>
        ) : (
          <Table
            label="Runs"
            rows={runs.data ?? []}
            rowKey={(run) => run.id}
            onRowClick={(run) => navigate(runHref(run))}
            empty="No runs yet. Pick a scan on the Workflows screen to start one."
            columns={[
              {
                key: "scan",
                header: "Scan",
                cell: (run) => <b className="font-semibold">{run.input.name}</b>,
              },
              {
                key: "workflow",
                header: "Workflow",
                cell: (run) => workflowName(run.workflows[0]?.path),
              },
              {
                key: "status",
                header: "Status",
                cell: (run) => (
                  <div className="grid gap-0.5">
                    <RunBadge run={run} />
                    <span className="text-meta text-muted-foreground">{runStatus(run).detail}</span>
                  </div>
                ),
              },
              {
                key: "time",
                header: "Time",
                align: "end",
                cell: (run) => {
                  const seconds = runSeconds(run);
                  return seconds === null ? "" : formatDuration(seconds);
                },
              },
              {
                key: "cost",
                header: "Cost",
                align: "end",
                cell: (run) =>
                  run.usage && run.state.status !== "queued" ? (
                    <div className="grid gap-0.5">
                      <span>{formatUsd(run.usage.modelCostUsd)}</span>
                      {run.usage.sandboxSeconds > 0 && (
                        <span className="text-meta text-muted-foreground">
                          Sandbox {formatDuration(run.usage.sandboxSeconds)}
                        </span>
                      )}
                    </div>
                  ) : (
                    ""
                  ),
              },
              { key: "finished", header: "Finished", cell: finished },
            ]}
          />
        )}
      </div>
    </main>
  );
}

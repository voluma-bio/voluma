/**
 * What the header line says in the scan review: the study and the scan, its group, where the run
 * stands, and Run details (how long it took, its workflow, Stop while it goes). Below the header,
 * over the views: the run's own problems (it waits for its starter's keys, it failed) and a lost
 * connection.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, cancelRun, resendKeys } from "@voluma/api-client";
import { runQuery } from "@voluma/api-client/query";
import type { Run } from "@voluma/contracts/run";
import type { StudyDetail } from "@voluma/contracts/study";
import {
  formatDuration,
  KeysForm,
  plainError,
  runStatus,
  scanLabel,
  useNow,
} from "@voluma/run-view";
import { Button, Facts, Popover, ShellHeading, type Status, StatusMark } from "@voluma/ui";
import { catalog, workflowName } from "@voluma/workflow/bundled";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

/** "OA6-1, right knee", from the study's scan; the scan's file name when the study can't say. */
export function scanTitle(run: Run, study: StudyDetail | undefined) {
  const scan = study?.scans.find((s) => s.scan.inputId === run.input.id)?.scan;
  if (!scan) return { title: run.input.name, group: null };
  return { title: scanLabel(scan), group: scan.group };
}

/** The study's workflow by its name; a run pinned to an older path still names it. */
const workflowLabel = (run: Run, study: StudyDetail | undefined) => {
  const id = study?.study.workflowId;
  return id && id in catalog
    ? catalog[id as keyof typeof catalog].name
    : workflowName(run.workflows[0]?.path);
};

/** How long it ran: to its end, or ticking while it goes. */
function useTook(run: Run) {
  const { state } = run;
  const startedAt = state.status === "queued" ? undefined : state.startedAt;
  const endedAt = state.status === "ended" ? state.endedAt : undefined;
  const now = useNow(startedAt !== undefined && endedAt === undefined);
  return startedAt
    ? formatDuration(((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000)
    : undefined;
}

/**
 * Where the run stands in a few words: "Finished in 52 min", "Running, 4 of 9 tasks done",
 * "Waiting, place 2 in line" (also a run that lost its runner and waits for another); otherwise
 * the word every list uses (`runStatus`).
 */
function where(
  run: Run,
  progress: { done: number; total: number },
  took: string | undefined,
): { status?: Status; text: string } {
  const { state } = run;
  if (state.status === "queued")
    return { status: "waiting", text: `Waiting, place ${state.position} in line` };
  if (state.status === "running")
    return {
      status: "running",
      text:
        progress.total > 0
          ? `Running, ${progress.done} of ${progress.total} tasks done`
          : "Running",
    };
  if (state.status === "ended" && state.outcome === "completed")
    return { text: took ? `Finished in ${took}` : "Finished" };
  const { label, status } = runStatus(run);
  return { status, text: label };
}

export function ScanHeading({
  run,
  study,
  progress,
}: {
  run: Run;
  study: StudyDetail | undefined;
  progress: { done: number; total: number };
}) {
  const { title, group } = scanTitle(run, study);
  const took = useTook(run);
  const now = where(run, progress, took);
  return (
    <ShellHeading>
      <nav aria-label="Where you are" className="flex min-w-0 items-center gap-2 text-sm">
        {study ? (
          <Link
            to={`/studies/${study.study.id}`}
            className="truncate text-muted-foreground hover:text-foreground"
          >
            {study.study.name}
          </Link>
        ) : (
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            Home
          </Link>
        )}
        <span aria-hidden className="text-fg-subtle">
          /
        </span>
        <h1 className="truncate font-semibold">{title}</h1>
      </nav>
      {group && <span className="shrink-0 text-sm text-muted-foreground">{group}</span>}
      {now.status ? (
        <StatusMark status={now.status} label={now.text} className="shrink-0" />
      ) : (
        <span className="shrink-0 text-sm text-muted-foreground">{now.text}</span>
      )}
      <RunDetails run={run} took={took} workflow={workflowLabel(run, study)} />
    </ShellHeading>
  );
}

function RunDetails({ run, took, workflow }: { run: Run; took?: string; workflow: string }) {
  const live = run.state.status !== "ended";
  return (
    <Popover
      label="Run details"
      align="start"
      className="w-72"
      trigger={
        <Button variant="ghost" size="sm" className="shrink-0">
          Run details
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <Facts
        items={[
          [live ? "Running for" : "Took", took ?? "Not started"],
          ["Workflow", workflow],
        ]}
      />
      {live && <StopRun run={run} />}
    </Popover>
  );
}

/** Stop, with a confirm, while the run is not over. */
function StopRun({ run }: { run: Run }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: (next) => client.setQueryData(runQuery(run.id).queryKey, next),
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {confirming ? (
        <>
          <span className="text-sm">Stop this run?</span>
          <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Stopping…" : "Stop run"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep running
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => setConfirming(true)}>
          Stop run
        </Button>
      )}
      {cancel.isError && (
        <p role="alert" className="w-full text-sm text-destructive">
          Couldn't stop the run. Try again.
        </p>
      )}
    </div>
  );
}

/** The run's own problems, over the views: waiting for its starter's keys, failed, or out of touch. */
export function RunAlert({ run, userId, stale }: { run: Run; userId: string; stale: boolean }) {
  const client = useQueryClient();
  const resend = useMutation({
    mutationFn: (keys: Parameters<typeof resendKeys>[1]) => resendKeys(run.id, keys),
    onSuccess: (next) => client.setQueryData(runQuery(run.id).queryKey, next),
  });
  const { state } = run;
  const bar = "shrink-0 border-b border-border px-4 py-2 text-sm";
  if (state.status === "awaiting-keys")
    return run.startedBy === userId ? (
      <section className={`${bar} grid gap-2 bg-check-tint text-check-strong`}>
        <p>The run is waiting for your keys: the server restarted and no longer has them.</p>
        <div className="max-w-sm">
          <KeysForm
            userId={userId}
            submitLabel="Continue the run"
            busy={resend.isPending}
            onSubmit={(keys) => resend.mutate(keys)}
          />
        </div>
        {resend.isError && (
          <p role="alert" className="text-destructive">
            {resend.error instanceof ApiError && resend.error.status === 429
              ? "Too many runs are waiting right now. Try again shortly."
              : "Couldn't send the keys. Try again."}
          </p>
        )}
      </section>
    ) : (
      <p className={`${bar} bg-check-tint text-check-strong`}>
        The run is waiting for the keys of the person who started it.
      </p>
    );
  if (state.status === "ended" && state.outcome === "failed")
    return (
      <p role="alert" className={`${bar} bg-destructive-tint text-destructive`}>
        {failureText(state.error)}
      </p>
    );
  if (stale)
    return (
      <p role="status" className={`${bar} bg-muted text-muted-foreground`}>
        Couldn't reach the server. Showing what was loaded; retrying.
      </p>
    );
  return null;
}

/** Why the run failed: the run's error without the provider's raw response. */
function failureText(error: string | undefined): string {
  if (!error) return "The run failed.";
  const words = plainError(error);
  return `The run failed: ${words}${/[.!?]$/.test(words) ? "" : "."}`;
}

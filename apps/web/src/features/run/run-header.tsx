/**
 * The run page's header and the run's own alerts. Header: where the run sits (its study, or Home
 * for a study of one), the scan and knee, the group and workflow; how far it got and how much is
 * left to check; Run details (started, took, settled cost); Stop while it is live; Open in 3D.
 * Alerts: the visitor-keys form while the run waits for its starter's keys, and why it failed.
 */

import { useMutation } from "@tanstack/react-query";
import { ApiError, cancelRun, resendKeys } from "@voluma/api-client";
import type { Run } from "@voluma/contracts/run";
import type { RunSpend } from "@voluma/contracts/spend";
import type { StudyDetail } from "@voluma/contracts/study";
import {
  formatDuration,
  formatUsd,
  KeysForm,
  plainError,
  shortDate,
  useNow,
} from "@voluma/run-view";
import {
  Button,
  Facts,
  Popover,
  PopoverClose,
  Progress,
  type Status,
  StatusMark,
} from "@voluma/ui";
import { catalog, workflowName } from "@voluma/workflow/bundled";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { reviewHref } from "./overview";

const { taskTitle } = catalog["mouse-oa"];

/** "OA6-1, right knee", from the study's scan; the scan's file name when the study can't say. */
function scanTitle(run: Run, study: StudyDetail | undefined) {
  const scan = study?.scans.find((s) => s.scan.inputId === run.input.id)?.scan;
  if (!scan) return { title: run.input.name, group: null };
  const knee = scan.attributes.knee;
  return {
    title: typeof knee === "string" ? `${scan.subject}, ${knee.toLowerCase()} knee` : scan.subject,
    group: scan.group,
  };
}

/** The study's workflow by its name; a run pinned to an older path still names it. */
const workflowLabel = (run: Run, study: StudyDetail | undefined) => {
  const id = study?.study.workflowId;
  return id && id in catalog
    ? catalog[id as keyof typeof catalog].name
    : workflowName(run.workflows[0]?.path);
};

/**
 * Where the run is, as a status mark beside its progress; the header counts items to check
 * beside it, so the word carries no count. A queued run with a plan has started (it lost its
 * runner), so it reads Paused.
 */
function runState(run: Run, started: boolean): { status: Status; label?: string } {
  const { state } = run;
  switch (state.status) {
    case "queued":
      return { status: started ? "paused" : "waiting" };
    case "running":
      return { status: "running" };
    case "awaiting-keys":
      return { status: "check", label: "Needs your keys" };
    case "ended":
      return state.outcome === "completed"
        ? { status: "done" }
        : state.outcome === "failed"
          ? { status: "stopped", label: "Failed" }
          : { status: "stopped" };
  }
}

export function RunHeader({
  run,
  study,
  progress: { done, total, toCheck },
  spend,
  openTask,
  agents,
  onChange,
}: {
  run: Run;
  study: StudyDetail | undefined;
  /** `progress` (total is 0 before the run has a plan), less what was accepted on this page. */
  progress: { done: number; total: number; toCheck: number };
  spend: RunSpend;
  /** The task "Open in 3D" opens: the one in view, else the first to check. */
  openTask?: string;
  /** Where "What the AI did" goes. */
  agents: string;
  onChange: (run: Run) => void;
}) {
  const { title, group } = scanTitle(run, study);
  const { state } = run;
  const crumb =
    study && study.scans.length > 1
      ? { to: `/studies/${study.study.id}`, label: study.study.name }
      : { to: "/", label: "Home" };
  const live = state.status !== "ended";
  const workflow = workflowLabel(run, study);
  return (
    <header className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-7 border-b border-border bg-card px-6 py-3 max-[1100px]:grid-cols-1 max-[1100px]:gap-3 max-[1100px]:px-4">
      <div className="min-w-0">
        <Button asChild variant="link" className="text-meta">
          <Link to={crumb.to}>{crumb.label}</Link>
        </Button>
        <h1 className="mt-0.5 truncate text-lg font-semibold">{title}</h1>
        <p className="flex flex-wrap gap-x-4 text-ui text-muted-foreground">
          {group && <span>{group}</span>}
          <span>{workflow}</span>
        </p>
      </div>

      <div className="w-full max-w-lg justify-self-center max-[1100px]:justify-self-start">
        <p className="mb-1.5 flex flex-wrap items-baseline gap-x-3.5 text-ui">
          <StatusMark {...runState(run, total > 0)} className="self-center font-semibold" />
          {total > 0 && (
            <span>
              {done} of {total} tasks done
            </span>
          )}
          {state.status === "queued" && <span>Place {state.position} in line</span>}
          {toCheck > 0 && (
            <span className="font-semibold text-check-strong">
              {toCheck} {toCheck === 1 ? "item" : "items"} to check
            </span>
          )}
        </p>
        <Progress
          look="bar"
          states={Array.from({ length: total }, (_, i) => (i < done ? "done" : "waiting"))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <RunDetails
          run={run}
          spend={spend}
          workflow={workflow}
          budgetUsd={study?.study.budgetUsd ?? null}
          agents={agents}
        />
        {live && <StopRun run={run} onChange={onChange} />}
        {(state.status !== "queued" || run.tasks) && (
          <Button asChild variant="primary" size="sm">
            <Link to={reviewHref(run.id, openTask)}>Open in 3D</Link>
          </Button>
        )}
      </div>
    </header>
  );
}

function RunDetails({
  run,
  spend,
  workflow,
  budgetUsd,
  agents,
}: {
  run: Run;
  spend: RunSpend;
  workflow: string;
  budgetUsd: number | null;
  agents: string;
}) {
  const { state } = run;
  const startedAt = state.status === "queued" ? undefined : state.startedAt;
  const endedAt = state.status === "ended" ? state.endedAt : undefined;
  const now = useNow(startedAt !== undefined && endedAt === undefined);
  const rows: [string, string][] = [
    ["Started", startedAt ? shortDate(startedAt) : "Not yet"],
    ...(startedAt
      ? ([
          [
            endedAt ? "Took" : "Running for",
            formatDuration(((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000),
          ],
        ] as [string, string][])
      : []),
    [
      "Cost",
      // Paid tool calls cut off before their cost arrived add no dollars.
      spend.total.unknownCostCalls > 0
        ? `${formatUsd(spend.total.costUsd)} + ${spend.total.unknownCostCalls} unknown`
        : formatUsd(spend.total.costUsd),
    ],
    ...(budgetUsd !== null ? ([["Study budget", formatUsd(budgetUsd)]] as [string, string][]) : []),
    ["Workflow", workflow],
  ];
  return (
    <Popover
      label="Run details"
      className="w-72"
      trigger={
        <Button variant="ghost" size="sm">
          Run details
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <Facts items={rows} />
      <PopoverClose asChild>
        <div className="mt-3 border-t border-border pt-3">
          <Button asChild variant="link">
            <Link to={agents}>What the AI did</Link>
          </Button>
        </div>
      </PopoverClose>
    </Popover>
  );
}

/** Stop, with a confirm, while the run is not over. */
function StopRun({ run, onChange }: { run: Run; onChange: (run: Run) => void }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: onChange });
  return (
    <>
      {cancel.isError && (
        <span role="alert" className="text-ui text-destructive">
          Couldn't stop the run. Try again.
        </span>
      )}
      {confirming ? (
        <>
          <span className="text-ui">Stop this run?</span>
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
    </>
  );
}

/** The run's own problems: it is waiting for the keys of the user who started it, or it failed. */
export function RunAlerts({
  run,
  userId,
  onChange,
}: {
  run: Run;
  userId: string;
  onChange: (run: Run) => void;
}) {
  const resend = useMutation({
    mutationFn: (keys: Parameters<typeof resendKeys>[1]) => resendKeys(run.id, keys),
    onSuccess: onChange,
  });
  const { state } = run;
  if (state.status === "awaiting-keys")
    return run.startedBy === userId ? (
      <section className="mb-8 max-w-sm rounded-xl border border-check-line bg-check-tint p-4">
        <h2 className="font-medium text-check-strong">The run is waiting for your keys</h2>
        <p className="mt-1 mb-3 text-ui text-check-strong">
          The server restarted and no longer has them. Send them again to continue.
        </p>
        <KeysForm
          userId={userId}
          submitLabel="Continue the run"
          busy={resend.isPending}
          onSubmit={(keys) => resend.mutate(keys)}
        />
        {resend.isError && (
          <p role="alert" className="mt-2 text-ui text-destructive">
            {resend.error instanceof ApiError && resend.error.status === 429
              ? "Too many runs are waiting right now. Try again shortly."
              : "Couldn't send the keys. Try again."}
          </p>
        )}
      </section>
    ) : (
      <p className="mb-8 rounded-xl bg-check-tint px-4 py-3 text-ui text-check-strong">
        The run is waiting for the keys of the person who started it.
      </p>
    );
  if (state.status === "ended" && state.outcome === "failed")
    return (
      <p
        role="alert"
        className="mb-8 rounded-xl bg-destructive-tint px-4 py-3 text-ui text-destructive"
      >
        {failureText(state.error)}
      </p>
    );
  return null;
}

/**
 * Why the run failed, in the researcher's words: the server writes "intake: its worker failed
 * on a model provider error: OpenAI API error (401): {...}"; the task gets its title, the
 * worker and check become the AI, and the provider's raw response is cut.
 */
function failureText(error: string | undefined): string {
  if (!error) return "The run failed.";
  const words = plainError(error).replace(
    /^([\w-]+): its (worker|check|checker)\b/,
    (_, task: string, role: string) =>
      `${taskTitle(task)}: ${role === "worker" ? "the AI" : "the second AI check"}`,
  );
  return `The run failed. ${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? "" : "."}`;
}

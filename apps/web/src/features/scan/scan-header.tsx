/**
 * What the header line says in the scan review: the study and the scan, its group, where the run
 * stands, and Run details: what the researcher may ask (how long it took, its workflow and models,
 * its cost, Stop while it goes), then what someone fixing a run needs (times, ids, commits, keys, failures,
 * gateway requests). Below the header,
 * over the views: the run's own problems (it waits for its starter's keys, it failed) and a lost
 * connection.
 */
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, cancelRun, resendKeys } from "@voluma/api-client";
import { runQuery } from "@voluma/api-client/query";
import type { Run, RunRead, VisitorKeys } from "@voluma/contracts/run";
import type { StudyDetail } from "@voluma/contracts/study";
import { failedThreads } from "@voluma/contracts/threads";
import {
  formatDuration,
  formatUsd,
  KeysForm,
  loadKeys,
  runCost,
  runStatus,
  runWork,
  scanLabel,
  stoppedText,
  type Thread,
  useEvents,
  useNow,
  useThreads,
} from "@voluma/run-view";
import {
  Button,
  type FactSection,
  FactSections,
  IconButton,
  Popover,
  ShellHeading,
  type Status,
  StatusMark,
} from "@voluma/ui";
import { catalog, workflowName } from "@voluma/workflow/bundled";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

/**
 * Where the run stands in a few words: "Finished", "Running, 4 of 9 tasks done", "Waiting, place
 * 2 in line" (also a run that lost its runner and waits for another); otherwise the word every
 * list uses (`runStatus`). How long it took is in Run details.
 */
function where(
  run: Run,
  progress: { done: number; total: number },
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
  if (state.status === "ended" && state.outcome === "completed") return { text: "Finished" };
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
  const now = where(run, progress);
  return (
    <ShellHeading>
      <nav aria-label="Where you are" className="flex min-w-0 items-center gap-2 text-sm">
        {study ? (
          study.scans.length > 1 ? (
            <Link
              to={`/studies/${study.study.id}`}
              className="truncate text-muted-foreground hover:text-foreground"
            >
              {study.study.name}
            </Link>
          ) : (
            <span className="truncate text-muted-foreground">{study.study.name}</span>
          )
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
      <RunDetails run={run} workflow={workflowLabel(run, study)} />
    </ShellHeading>
  );
}

function RunDetails({ run, workflow }: { run: Run; workflow: string }) {
  const live = run.state.status !== "ended";
  return (
    <Popover
      label="Run details"
      align="start"
      trigger={
        <Button variant="ghost" size="sm" className="shrink-0">
          Run details
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <RunFacts run={run} workflow={workflow} />
      {live && <StopRun run={run} />}
    </Popover>
  );
}

const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

const ROLE_MODEL = { main: "Lead AI model", worker: "Task AI model", check: "Second check model" };

/**
 * Which model the run calls: one "Model" line when every agent uses the same, else a line per
 * role listing its models; none before an agent records one.
 */
function modelItems(threads: Thread[]): FactSection["items"] {
  const byRole = new Map<keyof typeof ROLE_MODEL, Set<string>>();
  for (const role of Object.keys(ROLE_MODEL) as (keyof typeof ROLE_MODEL)[]) {
    const models = new Set<string>();
    for (const t of threads) if (t.place === role && t.model) models.add(t.model);
    if (models.size > 0) byRole.set(role, models);
  }
  const all = new Set([...byRole.values()].flatMap((m) => [...m]));
  if (all.size === 1) return [["Model", [...all][0]]];
  return [...byRole].map(([role, models]) => [
    models.size > 1 ? `${ROLE_MODEL[role]}s` : ROLE_MODEL[role],
    [...models].join(", "),
  ]);
}

/** Mounted only while Run details is open, so its clock and the log scan run only then. */
function RunFacts({ run, workflow }: { run: Run; workflow: string }) {
  const { state, providerCalls } = run;
  const live = state.status !== "ended";
  const events = useEvents();
  const work = runWork(events, state, useNow(live));
  const failed = useMemo(() => failedThreads(events).size, [events]);
  const threads = useThreads();
  const models = useMemo(() => modelItems(threads), [threads]);
  // Each claim records the commit its runner's checkout was at; a resume after a deploy adds one.
  const commits = useMemo(() => {
    const seen = new Set<string>();
    for (const e of events)
      if (e.type === "thread.started")
        for (const pin of e.payload.workflows ?? []) seen.add(pin.commit);
    return [...seen];
  }, [events]);
  const cost = formatUsd(runCost(run));
  const unknown = providerCalls.unknownCostCalls;
  const researcher: FactSection["items"] = [
    // Live, the sum includes earlier work: a correction adds to the run's total.
    [live ? "Worked so far" : "Took", work ? formatDuration(work.seconds) : "Not started"],
    ...(work?.redos ? [["Redos", String(work.redos)] as [string, string]] : []),
    ["Workflow", workflow],
    ...models,
    // A request of unknown cost adds nothing to the sum, so the sum is a floor.
    [live ? "Spent so far" : "Cost", unknown > 0 ? `At least ${cost}` : cost],
  ];
  const support: FactSection["items"] = [
    ["Started", work ? clock(work.startedAt) : "Not started"],
    ...(state.status === "ended" ? [["Ended", clock(state.endedAt)] as [string, string]] : []),
    ...(work?.reopens
      ? [["Messages after it finished", String(work.reopens)] as [string, string]]
      : []),
    ["Sandbox time", formatDuration(run.usage.sandboxSeconds)],
    ["Run id", <CopyId key="id" id={run.id} />],
    [
      commits.length > 1 ? "Workflow commits" : "Workflow commit",
      commits.length > 0 ? (
        <span className="font-mono text-xs" title={commits.join("\n")}>
          {commits.map((c) => c.slice(0, 7)).join(", ")}
        </span>
      ) : (
        "Not recorded yet"
      ),
    ],
    ["Keys", run.credentials === "visitor" ? "The starter's own" : "Voluma's"],
    ["Failed agents", failed > 0 ? String(failed) : "None"],
    [
      "Gateway requests",
      `${providerCalls.calls.toLocaleString()}${unknown > 0 ? `, ${unknown.toLocaleString()} of unknown cost` : ""}`,
    ],
  ];
  return (
    <FactSections
      sections={[{ items: researcher }, { title: "For troubleshooting", items: support }]}
    />
  );
}

/** The run's id, in full, with a button that copies it. */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate font-mono text-xs" title={id}>
        {id}
      </span>
      <IconButton
        size="sm"
        label={copied ? "Copied" : "Copy run id"}
        onClick={() =>
          void navigator.clipboard.writeText(id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </span>
  );
}

/** Stop, with a confirm, while the run is not over. */
function StopRun({ run }: { run: Run }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: (next) => showRun(client, next),
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

const bar = "shrink-0 border-b border-border px-4 py-2 text-sm";

/** The run's own problems, over the views: waiting for its starter's keys, failed, or out of touch. */
export function RunAlert({ run, userId, stale }: { run: Run; userId: string; stale: boolean }) {
  const { state } = run;
  if (state.status === "awaiting-keys")
    return run.startedBy === userId ? (
      <AwaitingKeys run={run} userId={userId} />
    ) : (
      <p className={`${bar} bg-check-tint text-check-strong`}>
        The run is waiting for the keys of the person who started it.
      </p>
    );
  if (state.status === "ended" && state.outcome === "failed")
    return (
      <p role="alert" className={`${bar} bg-destructive-tint text-destructive`}>
        {stoppedText(state.error)}
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

/**
 * Failed sends the page retries by itself when the server or network is down, and the most it waits
 * between two. A 429 (too many runs going) is retried every MAX_WAIT_MS with no cap: it clears only
 * when other runs end, which can take longer than any cap would allow.
 */
const OUTAGE_SENDS = 30;
const MAX_WAIT_MS = 60_000;

const full = (error: unknown) => error instanceof ApiError && error.status === 429;
const down = (error: unknown) => !(error instanceof ApiError) || error.status >= 500;

/**
 * The starter's own run waiting for keys. Mounted once per wait, it sends the key stored in this
 * browser by itself, and again after a refusal that clears: a 429 every minute for as long as the
 * wait lasts, a 5xx or network error after a wait doubling from 5 s to a minute, OUTAGE_SENDS times.
 * A send from the form, which shows after the first failure, stops it. A 409 means the run already
 * left the wait (another tab sent the key): not an error.
 */
function AwaitingKeys({ run, userId }: { run: Run; userId: string }) {
  const client = useQueryClient();
  const [stored] = useState(() => loadKeys(userId));
  const [sends, setSends] = useState(0);
  const [outages, setOutages] = useState(0);
  const [manual, setManual] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const resend = useMutation({
    mutationFn: (keys: VisitorKeys) => resendKeys(run.id, keys),
    onSuccess: (next) => showRun(client, next),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setFailure(undefined);
        void client.invalidateQueries({ queryKey: runQuery(run.id).queryKey });
        return;
      }
      if (down(error)) setOutages((n) => n + 1);
      setFailure(error);
    },
  });
  const { mutate } = resend;
  const retrying =
    failure !== undefined &&
    !!stored &&
    !manual &&
    (full(failure) || (down(failure) && outages < OUTAGE_SENDS));
  const due = sends === 0 ? !!stored : retrying && resend.isError;
  const wait =
    sends === 0
      ? 0
      : full(failure)
        ? MAX_WAIT_MS
        : Math.min(5000 * 2 ** (outages - 1), MAX_WAIT_MS);
  // A timer even for the first send: StrictMode's second effect run clears the first timer.
  useEffect(() => {
    if (!due || !stored) return;
    const timer = setTimeout(() => {
      setSends((n) => n + 1);
      mutate(stored);
    }, wait);
    return () => clearTimeout(timer);
  }, [due, sends, wait, stored, mutate]);

  if (stored && !manual && failure === undefined)
    return (
      <p role="status" className={`${bar} bg-muted text-muted-foreground`}>
        The server restarted. Reconnecting with your saved key…
      </p>
    );
  const busy = manual && resend.isPending;
  return (
    <section className={`${bar} grid gap-2 bg-check-tint text-check-strong`}>
      <p>The run is waiting for your keys: the server restarted and no longer has them.</p>
      <div className="max-w-sm">
        <KeysForm
          userId={userId}
          submitLabel="Continue the run"
          busy={busy}
          onSubmit={(keys) => {
            setManual(true);
            setFailure(undefined);
            resend.mutate(keys);
          }}
        />
      </div>
      {failure !== undefined && !busy && (
        <p role="alert" className="text-destructive">
          {failureMessage(failure, retrying)}
        </p>
      )}
    </section>
  );
}

function failureMessage(error: unknown, retrying: boolean) {
  if (retrying)
    return full(error)
      ? "Too many runs are going right now. Your saved key will be sent again shortly."
      : "Couldn't send your saved key. Trying again shortly.";
  return full(error)
    ? "Too many runs are going right now. Try again shortly."
    : "Couldn't send the keys. Try again.";
}

/** Shows a run the API returned; first cancels a poll in flight, whose older read would land after it. */
async function showRun(client: QueryClient, next: RunRead) {
  const { queryKey } = runQuery(next.id);
  await client.cancelQueries({ queryKey });
  client.setQueryData(queryKey, next);
}

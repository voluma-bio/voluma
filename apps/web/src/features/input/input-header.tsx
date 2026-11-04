/**
 * The input review's header line: the breadcrumb ending in the input, its group, run status,
 * and Run details: what the researcher may ask (how long it took, its workflow and models,
 * its cost, Stop while it goes), then what someone fixing a run needs (times, ids, commits, keys, failures,
 * gateway requests). Below the header,
 * over the views: the run's own problems (it waits for its starter's keys, it failed) and a lost
 * connection.
 */
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelRun } from "@voluma/api-client";
import { runQuery } from "@voluma/api-client/query";
import type { Run, RunRead } from "@voluma/contracts/run";
import type { StudyDetail } from "@voluma/contracts/study";
import { failedThreads } from "@voluma/contracts/threads";
import {
  formatDuration,
  formatUsd,
  inputLabel,
  KeysForm,
  loadKeys,
  runCost,
  runStatus,
  runWork,
  stoppedText,
  useEvents,
  useNow,
} from "@voluma/run-view";
import {
  Breadcrumb,
  Button,
  type FactSection,
  FactSections,
  IconButton,
  INPUT_WORD,
  Popover,
  ShellHeading,
  type Status,
  StatusMark,
} from "@voluma/ui";
import { workflowById, workflowName } from "@voluma/workflow/bundled";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";

/** "OA6-1, right knee", from the study's input; the input's file name when the study can't say. */
export function inputTitle(run: Run, study: StudyDetail | undefined) {
  const member = study?.inputs.find((s) => s.member.inputId === run.input.id)?.member;
  if (!member) return { title: run.input.name, group: null };
  return { title: inputLabel(member), group: member.group };
}

/** The study's workflow by its name; a run pinned to an older path still names it. */
const workflowLabel = (run: Run, study: StudyDetail | undefined) =>
  workflowById(study?.study.workflowId ?? "")?.name ?? workflowName(run.workflows[0]?.path);

/**
 * Where the run stands in a few words: "Run finished", "Running", "In queue: the system is busy, place
 * 2 in line" (also a run that lost its runner and waits for another); otherwise the word every
 * list uses (`runStatus`). How far it got is in Final outputs; how long it took is in Run details.
 */
function where(run: Run, waitingOnYou: boolean): { status: Status; text: string; detail?: string } {
  const { state } = run;
  // Main holds a call for your yes: until you answer, the run waits on you, going or ended.
  if (
    waitingOnYou &&
    (state.status === "running" || (state.status === "ended" && state.outcome === "completed"))
  )
    return { status: "check", text: "Waiting on you" };
  if (state.status === "queued")
    return {
      status: "waiting",
      text: "In queue",
      detail: `The system is busy, place ${state.position} in line.`,
    };
  if (state.status === "running") return { status: "running", text: "Running" };
  if (state.status === "ended" && state.outcome === "completed")
    return { status: "done", text: "Run finished" };
  const { label, status } = runStatus({ state, review: null });
  return { status, text: label };
}

export function InputHeading({
  run,
  study,
  waitingOnYou,
  toCheck,
  onToCheck,
}: {
  run: Run;
  study: StudyDetail | undefined;
  /** The run's main holds a call for your yes: the run waits on you. */
  waitingOnYou: boolean;
  toCheck: number;
  /** Shows the first open check. */
  onToCheck: () => void;
}) {
  const { title, group } = inputTitle(run, study);
  const now = where(run, waitingOnYou);
  const newest = study?.inputs.find((s) => s.member.inputId === run.input.id)?.runs[0];
  const earlier = newest && newest.id !== run.id;
  // One line: the breadcrumb ends in this sample, then where its run stands, which opens Run details.
  return (
    <InputBreadcrumb study={study} title={title}>
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {group && <span>Group: {group}</span>}
        {earlier && <span className="font-medium text-foreground">Earlier run</span>}
        <RunDetails run={run} workflow={workflowLabel(run, study)}>
          <StatusMark status={now.status} label={now.text} />
        </RunDetails>
        {toCheck > 0 && (
          <Button variant="ghost" size="sm" className="-ml-2" onClick={onToCheck}>
            <StatusMark status="check" label={`${toCheck} to check`} />
          </Button>
        )}
        {now.detail && <span>{now.detail}</span>}
      </div>
    </InputBreadcrumb>
  );
}

/** Also used while identity is loading or unavailable, so the Studies parent never disappears. */
export function InputBreadcrumb({
  study,
  title = INPUT_WORD.One,
  children,
}: {
  study?: StudyDetail;
  title?: string;
  /** The rest of the header line after the breadcrumb. */
  children?: ReactNode;
}) {
  return (
    <ShellHeading>
      <Breadcrumb
        trail={[
          { label: "Studies", to: (props) => <Link to="/" {...props} /> },
          ...(study
            ? [
                {
                  label: study.study.name,
                  to: (props: { className: string; children: ReactNode }) => (
                    <Link to={`/studies/${study.study.id}`} {...props} />
                  ),
                },
              ]
            : []),
        ]}
        current={title}
      />
      {children}
    </ShellHeading>
  );
}

/** Where the run stands (`children`) is the button that opens its details. */
function RunDetails({
  run,
  workflow,
  children,
}: {
  run: Run;
  workflow: string;
  children: ReactNode;
}) {
  const live = run.state.status !== "ended";
  return (
    <Popover
      label="Run details"
      align="start"
      // Wide enough for a usual model id ("deepseek/deepseek-v4-pro") on one line beside its role.
      className="w-96"
      trigger={
        <Button variant="ghost" size="sm" className="-ml-2 shrink-0">
          {children}
          <span className="sr-only">, run details</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
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

/** Mounted only while Run details is open, so its clock and the log input run only then. */
function RunFacts({ run, workflow }: { run: Run; workflow: string }) {
  const { state, providerCalls } = run;
  const live = state.status !== "ended";
  const events = useEvents();
  const work = runWork(events, state, useNow(live));
  const failed = useMemo(() => failedThreads(events).size, [events]);
  // Each claim records the commit its runner's checkout was at; a resume after a deploy adds one.
  const commits = useMemo(() => {
    const seen = new Set<string>();
    for (const e of events)
      if (e.type === "thread.started")
        for (const pin of e.payload.workflows ?? []) seen.add(pin.commit);
    return [...seen];
  }, [events]);
  // What the agents called; before any has started, the model the API picked (none on older runs).
  const models = useMemo(() => {
    const seen = new Set<string>();
    for (const e of events)
      if (e.type === "thread.started" && e.payload.model) seen.add(e.payload.model);
    return seen.size ? [...seen] : run.model ? [run.model] : [];
  }, [events, run.model]);
  const cost = formatUsd(runCost(run));
  const unknown = providerCalls.unknownCostCalls;
  const researcher: FactSection["items"] = [
    // Live, the sum includes earlier work: a correction adds to the run's total.
    [live ? "Worked so far" : "Took", work ? formatDuration(work.seconds) : "Not started"],
    ["Workflow", workflow],
    ["Source file", run.input.name],
    ...(models.length
      ? [
          [
            models.length > 1 ? "Models" : "Model",
            <span key="model" className="flex flex-col font-mono text-xs">
              {models.map((m) => (
                <ModelId key={m} id={m} />
              ))}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
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
    ["Keys", run.credentials !== "voluma" ? "The starter's own" : "Voluma's"],
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

/**
 * A model id that wraps only after a "/", never at a hyphen inside a name, with a hanging indent
 * so a wrapped id reads as one item in a list of them.
 */
function ModelId({ id }: { id: string }) {
  const parts = id.split("/");
  return (
    <span className="-indent-[1ch] pl-[1ch]">
      {parts.map((part, i) => (
        <Fragment key={i}>
          <span className="whitespace-nowrap">{i < parts.length - 1 ? `${part}/` : part}</span>
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
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

/** The run's own problems, over the views: failed, or out of touch. */
export function RunAlert({ run, userId, stale }: { run: RunRead; userId: string; stale: boolean }) {
  const { state } = run;
  if (
    state.status === "ended" &&
    state.outcome === "completed" &&
    run.credentials !== "voluma" &&
    run.cannotMessage === null
  )
    return <ReopenKeys userId={userId} />;
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
 * A finished own-key run holds no key, so a message to it needs the user's: the form shows until
 * this browser has one saved (the messages then carry it, `keysToReopen`), and "Change key"
 * brings it back to replace a wrong or revoked one.
 */
function ReopenKeys({ userId }: { userId: string }) {
  const [saved, setSaved] = useState(() => !!loadKeys(userId));
  const [changing, setChanging] = useState(false);
  if (saved && !changing)
    return (
      <p className={`${bar} flex items-center gap-2 bg-muted text-muted-foreground`}>
        Corrections to this run use your saved Meta key.
        <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
          Change key
        </Button>
      </p>
    );
  return (
    <section className={`${bar} grid gap-2 bg-muted text-muted-foreground`}>
      <p>
        This run used your own Meta key, which Voluma does not keep once a run ends. Add it to send
        a correction.
      </p>
      <div className="max-w-sm">
        <KeysForm
          userId={userId}
          submitLabel="Save key"
          onSubmit={() => {
            setSaved(true);
            setChanging(false);
          }}
        />
      </div>
    </section>
  );
}

/** Shows a run the API returned; first cancels a poll in flight, whose older read would land after it. */
async function showRun(client: QueryClient, next: RunRead) {
  const { queryKey } = runQuery(next.id);
  await client.cancelQueries({ queryKey });
  client.setQueryData(queryKey, next);
}

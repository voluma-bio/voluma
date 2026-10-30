/**
 * One task (`?task=<id>`): what the AI did in a line, the second AI check's verdict, its To check
 * items, its QC image and values, and "How the AI did it": the task's own threads as transcripts,
 * built only when the reader opens it. Tool names may show there and nowhere else on the page.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { buttonClass } from "@voluma/ui";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Elapsed, ThreadCost } from "./agents";
import { ClampedMarkdown } from "./chat/markdown";
import {
  type Accepting,
  doingNow,
  LookedRight,
  NeedCard,
  QcImage,
  ResultsTable,
  reviewHref,
  Section,
} from "./overview";
import type { TaskView as Task, Thread } from "./run-model";
import { TaskMark } from "./task-flow";
import { type Halt, type Live, threadRows } from "./transcript";
import { TranscriptView } from "./transcript-view";

export function TaskView({
  runId,
  task,
  titleOf,
  accepting,
  search,
  events,
  live,
  halt,
}: {
  runId: string;
  task: Task;
  titleOf: (taskId: string) => string;
  accepting: Accepting;
  search: (taskId?: string) => string;
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
}) {
  const { state } = task;
  const ended = state === "done" || state === "to-check" || state === "failed";
  const open = task.needs.filter((n) => !n.accepted && !accepting.done.has(n.id));
  const looked = task.needs.filter((n) => n.accepted || accepting.done.has(n.id));
  const imageShown = task.needs.some((n) => n.image?.id === task.image?.id);
  return (
    <>
      <Link
        to={search()}
        className="inline-flex items-center gap-1 text-ui font-medium text-primary-text hover:underline"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Overview
      </Link>
      <h2 className="mt-2 mb-1.5 text-xl font-semibold [text-wrap:balance]">
        {task.number}. {task.title}
      </h2>

      <div className="mb-6 grid max-w-[65ch] gap-2 text-[0.9375rem]">
        <Lead task={task} titleOf={titleOf} />
        <CheckLine task={task} />
      </div>

      {ended && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Link to={reviewHref(runId, task.id)} className={buttonClass({ size: "sm" })}>
            Open in 3D
          </Link>
        </div>
      )}

      {task.needs.length > 0 && (
        <Section title="Needs your eye" count={open.length}>
          <div className="grid gap-2.5">
            {open.map((n) => (
              <NeedCard key={n.id} runId={runId} item={n} accepting={accepting} />
            ))}
          </div>
          <LookedRight items={looked} />
        </Section>
      )}

      {task.image && !imageShown && (
        <figure className="mb-8">
          <QcImage
            runId={runId}
            asset={task.image}
            className="block max-h-90 w-full max-w-xl [&_img]:object-contain"
          />
          <figcaption className="mt-1.5 text-meta text-muted-foreground">QC image</figcaption>
        </figure>
      )}

      {task.valued && (
        <Section title="Results">
          <ResultsTable tasks={[task]} search={search} single />
        </Section>
      )}

      {task.threads.length > 0 && (
        <HowTheAiDidIt
          key={task.id}
          threads={task.threads}
          working={state === "running" || state === "checking"}
          events={events}
          live={live}
          halt={halt}
        />
      )}
    </>
  );
}

/** One line of where the task stands, then what the AI did once it has. */
function Lead({ task, titleOf }: { task: Task; titleOf: (taskId: string) => string }) {
  switch (task.state) {
    case "waiting":
      return (
        <p className="text-muted-foreground">Starts after {list(task.waitingOn.map(titleOf))}.</p>
      );
    case "ready":
      return <p className="text-muted-foreground">Starts when the AI gets to it.</p>;
    case "skipped":
      return <p className="text-muted-foreground">Skipped: {task.reason ?? "no reason given"}</p>;
    case "running":
    case "checking":
    case "paused":
      return (
        <p className="flex items-center gap-2.5">
          <TaskMark state={task.state} />
          {doingNow(task)}
          {task.latest && task.state !== "paused" && <Elapsed thread={task.latest} />}
        </p>
      );
    case "stopped":
      return <p className="text-muted-foreground">The run stopped before this task finished.</p>;
    case "failed":
      return (
        <p className="text-destructive">
          The AI couldn't finish this task{task.reason ? `: ${task.reason}` : "."}
        </p>
      );
    default:
      return task.did ? <ClampedMarkdown text={task.did} /> : null;
  }
}

/** The second AI check's verdict on the current result, with what it found. */
function CheckLine({ task }: { task: Task }) {
  if (!task.check || task.state === "running" || task.state === "checking") return null;
  const passed = task.check.verdict === "passed";
  return (
    <div className={passed ? "text-primary-text" : "text-check-strong"}>
      <p className="flex items-center gap-1.5 font-medium">
        {passed && <Check className="size-4" aria-hidden />}
        {passed
          ? "A second AI checked this and agrees."
          : task.rejected
            ? "A second AI checked this and sent it back."
            : "A second AI checked this and has doubts."}
      </p>
      {/* A task sent back shows the check's words on its card instead. */}
      {!task.needs.some((n) => n.text === task.check?.text) && (
        <ClampedMarkdown text={task.check.text} className="text-muted-foreground" />
      )}
    </div>
  );
}

const list = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The task's threads, each as its transcript: the AI's work (one per attempt) and the second
 * AI check. Closed unless the task is working; nothing is built until it opens.
 */
function HowTheAiDidIt({
  threads,
  working,
  events,
  live,
  halt,
}: {
  threads: Thread[];
  working: boolean;
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
}) {
  const [open, setOpen] = useState(working);
  const workers = threads.filter((t) => t.kind === "worker");
  return (
    <section className="rounded-xl border border-border bg-card">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-ui font-semibold"
        >
          <ChevronRight
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          How the AI did it
        </button>
      </h2>
      {open && (
        <div className="grid gap-6 border-t border-border px-4 pt-3 pb-4">
          {threads.map((t) => (
            <ThreadTranscript
              key={t.id}
              thread={t}
              label={
                t.kind === "check"
                  ? "Second AI check"
                  : workers.length > 1
                    ? `The AI's work, attempt ${workers.indexOf(t) + 1}`
                    : "The AI's work"
              }
              events={events}
              live={live}
              halt={halt}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ThreadTranscript({
  thread,
  label,
  events,
  live,
  halt,
}: {
  thread: Thread;
  label: string;
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
}) {
  const rows = useMemo(
    () => threadRows(events, thread.id, live, halt),
    [events, thread.id, live, halt],
  );
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-ui font-medium">
        {label}
        <span className="ml-auto" />
        <ThreadCost thread={thread} />
        <Elapsed thread={thread} />
      </h3>
      <TranscriptView
        rows={rows}
        live={thread.status === "running" ? (thread.liveTool ?? "Thinking") : null}
        empty={
          thread.status === "paused" || thread.status === "cancelled"
            ? "It was cut off before it wrote anything."
            : "Nothing yet."
        }
      />
    </div>
  );
}

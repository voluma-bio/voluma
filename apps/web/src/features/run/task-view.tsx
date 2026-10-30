/**
 * One task (`?task=<id>`): what the AI did in a line, the second AI check's verdict, its To check
 * items, its QC image and values, and "How the AI did it": the task's own threads as transcripts,
 * built only when the reader opens it. Tool names may show there and nowhere else on the page.
 */
import { buttonClass, cx } from "@voluma/ui";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { AgentThread } from "./agent-thread";
import { Elapsed } from "./agents";
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
  WhatItFound,
} from "./overview";
import type { TaskView as Task, Thread } from "./run-model";
import { TaskMark } from "./task-flow";

export function TaskView({
  runId,
  task,
  titleOf,
  accepting,
  search,
}: {
  runId: string;
  task: Task;
  titleOf: (taskId: string) => string;
  accepting: Accepting;
  search: (taskId?: string) => string;
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

      <div className="mb-6 grid max-w-[65ch] gap-2 text-sm">
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
            key={task.image.id}
            runId={runId}
            asset={task.image}
            className="block w-fit max-w-full"
            imageClassName="max-h-90 w-auto max-w-full"
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
      // A dependent's reason already says which task was skipped.
      return (
        <p className="text-muted-foreground">
          {task.reason
            ? / was skipped: /.test(task.reason)
              ? task.reason
              : `Skipped: ${task.reason}`
            : "Skipped."}
        </p>
      );
    case "running":
    case "checking":
    case "held":
    case "paused":
    case "awaiting-ai":
      return (
        <p className="flex items-center gap-2.5">
          <TaskMark state={task.state} />
          {doingNow(task)}
          {(task.state === "running" || task.state === "checking") && task.latest && (
            <Elapsed thread={task.latest} />
          )}
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
      return task.did ? (
        <ClampedMarkdown text={task.did} />
      ) : task.purpose ? (
        <p className="text-muted-foreground">{task.purpose}</p>
      ) : null;
  }
}

/**
 * The second AI check's verdict on the current result: its sentence, with its own words behind
 * "What it found". A task sent back shows them on its card instead.
 */
function CheckLine({ task }: { task: Task }) {
  const { check } = task;
  if (!check || task.state === "running" || task.state === "checking") return null;
  const passed = check.verdict === "passed";
  const onCard = task.needs.some((n) => n.found === check.text);
  return (
    <div>
      <p
        className={cx(
          "flex items-center gap-1.5 font-medium",
          passed ? "text-primary-text" : "text-check-strong",
        )}
      >
        {passed && <Check className="size-4" aria-hidden />}
        {passed
          ? "A second AI checked this and agrees."
          : task.rejected
            ? "A second AI checked this and sent it back."
            : "A second AI checked this and has doubts."}
      </p>
      {!onCard && check.summary && <p className="mt-0.5">{check.summary}</p>}
      {!onCard && <WhatItFound text={check.text} className="mt-1" />}
    </div>
  );
}

const list = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The task's agents, each as its thread (`AgentThread`): the AI's work, its tries in one thread,
 * and a second AI check per try. Closed unless the task is working; nothing is built until it opens.
 */
function HowTheAiDidIt({ threads, working }: { threads: Thread[]; working: boolean }) {
  const [open, setOpen] = useState(working);
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
            <AgentThread key={t.id} threadId={t.id} className="max-h-[36rem]" />
          ))}
        </div>
      )}
    </section>
  );
}

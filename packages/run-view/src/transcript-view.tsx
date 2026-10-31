/**
 * One transcript: the rows from `transcript.ts` rendered the way Meridian Flow renders an
 * assistant turn, in the page's own scroll. Prose stays visible; process folds stay closed until
 * the reader opens them; a running thread ends in a live line naming what it is doing.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { StatusMark } from "@voluma/ui";
import {
  Brain,
  Cog,
  Flag,
  Image,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PackageCheck,
  Terminal,
  Wand,
} from "lucide-react";
import type { ReactNode } from "react";
import { AgentCard } from "./agents";
import { ActivityRow } from "./chat/activity-row";
import { Markdown, StreamingText } from "./chat/markdown";
import { ProcessDisclosure } from "./chat/process-disclosure";
import { ReplyInfo } from "./info";
import { plainError } from "./run-error";
import type { Thread } from "./run-model";
import { formatUsd } from "./run-status";
import type { Row, Step, ToolStep } from "./transcript";

export function TranscriptView({
  rows,
  threads,
  live,
  empty,
}: {
  rows: Row[];
  /** For the lead AI's transcript: the threads its agent rows show as cards. */
  threads?: Map<string, Thread>;
  /** While the thread works: what it is doing now, for the live line at the end. */
  live?: string | null;
  empty: string;
}) {
  return (
    <div className="min-w-0">
      {rows.length === 0 ? (
        <p className="text-ui text-muted-foreground">{empty}</p>
      ) : (
        <ol className="grid gap-3">
          {rows.map((row) => (
            <li key={row.id} className="min-w-0">
              <RowView row={row} threads={threads} />
            </li>
          ))}
        </ol>
      )}
      {live !== undefined && live !== null && (
        <p className="mt-3 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          <span
            className="size-2 shrink-0 rounded-full bg-info motion-safe:animate-pulse"
            aria-hidden
          />
          <span className="min-w-0 truncate font-mono">
            {live || <span className="sr-only">Running</span>}
          </span>
        </p>
      )}
    </div>
  );
}

function RowView({ row, threads }: { row: Row; threads?: Map<string, Thread> }) {
  switch (row.kind) {
    case "prose":
      return (
        <div className="group relative">
          <StreamingText text={row.text} streaming={row.streaming} />
          {row.usage && (
            // Wide, in the gutter left of the reply on hover or focus; narrow, there is no gutter,
            // so it sits under the reply, always shown.
            <div className="flex justify-end min-[1100px]:absolute min-[1100px]:top-0 min-[1100px]:-left-8 min-[1100px]:opacity-0 min-[1100px]:transition-opacity min-[1100px]:group-hover:opacity-100 min-[1100px]:focus-within:opacity-100">
              <ReplyInfo usage={row.usage} miss={row.cacheMiss} />
            </div>
          )}
        </div>
      );
    case "process":
      return (
        <ProcessDisclosure label={row.digest}>
          <div className="space-y-1">
            {row.steps.map((s) => (
              <StepView key={s.id} step={s} />
            ))}
          </div>
        </ProcessDisclosure>
      );
    case "brief":
      return (
        <ProcessDisclosure label={row.label}>
          <Markdown text={row.text} className="rounded-lg bg-muted px-3 py-2 text-ui" />
        </ProcessDisclosure>
      );
    case "checkpoint":
      return <Checkpoint event={row.event} />;
    case "output":
      return <OutputRow event={row.event} />;
    case "failure":
      return (
        <p
          role="alert"
          className="rounded-xl bg-destructive-tint px-3 py-2 text-ui whitespace-pre-wrap text-destructive"
        >
          {plainError(row.text)}
        </p>
      );
    case "agent": {
      const thread = threads?.get(row.threadId);
      return thread ? <AgentCard thread={thread} /> : null;
    }
  }
}

const TOOL_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  view_image: Image,
  start_worker: ListChecks,
  start_agent: ListChecks,
  submit_task: ListChecks,
  checkpoint: Flag,
  report_output: PackageCheck,
  message: MessageSquare,
  answer: MessageSquare,
  ask: MessageSquare,
  segment_sam: Wand,
};

function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case "reasoning":
      return (
        <ActivityRow Icon={Brain} quietIcon proseClassName="italic text-fg-subtle">
          <Markdown text={step.text} />
        </ActivityRow>
      );
    case "note":
      return <ActivityRow Icon={Cog} title={step.text} status={step.failed ? "error" : "done"} />;
    case "tool":
      return (
        <ActivityRow
          Icon={(step.name && TOOL_ICON[step.name]) || Terminal}
          title={
            <span className={step.name === "bash" || !step.name ? "font-mono text-meta" : ""}>
              {step.title}
            </span>
          }
          status={step.status}
          expand={() => <ToolBody step={step} />}
        />
      );
  }
}

function ToolBody({ step }: { step: ToolStep }) {
  const command = (step.input as { command?: unknown } | undefined)?.command;
  const input =
    step.args ??
    (step.name === "bash" && typeof command === "string"
      ? command
      : JSON.stringify(step.input, null, 2));
  return (
    <div className="grid gap-1.5">
      <Pre>{input}</Pre>
      {step.output !== undefined && (
        <Pre tone={step.status === "error" ? "error" : undefined}>
          {step.output || "(no output)"}
        </Pre>
      )}
      {step.truncated && (
        <p className="text-meta text-muted-foreground">
          Shortened: part of the output is not shown.
        </p>
      )}
    </div>
  );
}

function Pre({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <pre
      className={`max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-meta whitespace-pre-wrap break-words ${
        tone === "error" ? "bg-destructive-tint text-destructive" : "bg-muted text-foreground"
      }`}
    >
      {children}
    </pre>
  );
}

function Checkpoint({ event }: { event: Extract<RunEvent, { type: "checkpoint" }> }) {
  const { verdict, toCheck, text, evidence } = event.payload;
  const body = (
    <div className="flex min-w-0 items-start gap-2">
      <Flag className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        {(verdict || toCheck) && (
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {verdict && (
              <StatusMark
                status={verdict === "passed" ? "done" : "check"}
                label={verdict === "passed" ? "Check passed" : "Needs review"}
              />
            )}
            {toCheck && <StatusMark status="check" label={`To check: ${toCheck.title}`} />}
          </div>
        )}
        <Markdown text={text} className="text-ui" />
        {evidence.length > 0 && (
          <p
            className="mt-1 truncate font-mono text-meta text-fg-subtle"
            title={evidence.map((r) => r.path).join("\n")}
          >
            {evidence.map((r) => r.path.split("/").pop()).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
  return toCheck || verdict === "needs-review" ? (
    <div className="rounded-xl border border-check-line bg-check-tint px-3 py-2 text-check-strong">
      {body}
    </div>
  ) : (
    body
  );
}

function outputValue(o: Extract<RunEvent, { type: "output" }>["payload"]["output"]): string | null {
  switch (o.kind) {
    case "measurement":
      return `${o.value} ${o.unit}`;
    case "score":
      return String(o.level);
    case "structure":
      return o.volumeMm3 !== undefined ? `${o.volumeMm3} mm³` : null;
    default:
      return null;
  }
}

function OutputRow({ event }: { event: Extract<RunEvent, { type: "output" }> }) {
  const value = outputValue(event.payload.output);
  return (
    <p className="flex min-w-0 items-center gap-2 text-ui">
      <PackageCheck className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate">
        Reported <span className="font-medium">{event.payload.title}</span>
      </span>
      {value && <span className="shrink-0 font-mono text-meta tabular-nums">{value}</span>}
    </p>
  );
}

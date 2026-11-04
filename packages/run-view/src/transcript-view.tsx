/**
 * One agent's rows (`transcript.ts`) as a thread: prose stays visible; reasoning and runs of tool
 * calls fold closed under a short label, their bodies built on first open; a working thread ends
 * in a live line naming the call it is in.
 */
import {
  Activity,
  Brain,
  Cog,
  FileText,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PackageCheck,
  Terminal,
  UserMinus,
  UserPlus,
  Wand,
} from "lucide-react";
import type { ReactNode } from "react";
import { ActivityRow } from "./chat/activity-row";
import { Markdown } from "./chat/markdown";
import { ProcessDisclosure } from "./chat/process-disclosure";
import { plainError } from "./run-error";
import type { Row, Step, ToolStep } from "./transcript";

/** The agents a name in the thread can open: the names that are agents, and what opening one does. */
export type AgentLinks = { names: ReadonlySet<string>; open: (name: string) => void };

/** Most of a call's arguments or output shown when its fold opens; the tail is kept. */
const SHOWN_CHARS = 8000;

export function TranscriptView({
  rows,
  links,
  live,
  empty,
}: {
  rows: Row[];
  links?: AgentLinks;
  /** While the thread works: what it is doing now, for the live line at the end ("" when it names nothing). */
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
              <RowView row={row} links={links} />
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
            {live || <span className="sr-only">Working</span>}
          </span>
        </p>
      )}
    </div>
  );
}

function RowView({ row, links }: { row: Row; links?: AgentLinks }) {
  switch (row.kind) {
    case "prose":
      return <Markdown text={row.text} className="text-ui" />;
    case "process":
      return (
        <ProcessDisclosure label={row.digest}>
          <div className="space-y-1">
            {row.steps.map((s) => (
              <StepView key={s.id} step={s} links={links} />
            ))}
          </div>
        </ProcessDisclosure>
      );
    case "said":
      return (
        <div className="grid gap-1 border-l-2 border-primary pl-3">
          <p className="text-meta text-muted-foreground">To the researcher</p>
          <Markdown text={row.text} className="text-ui" />
        </div>
      );
    case "brief":
      return (
        <ProcessDisclosure label={row.label}>
          <Markdown text={row.text} className="rounded-lg bg-muted px-3 py-2 text-ui" />
        </ProcessDisclosure>
      );
    case "divider":
      return (
        <p className="flex items-center gap-3 text-meta text-muted-foreground">
          <span className="h-px flex-1 bg-border" aria-hidden />
          <span className="font-mono">{row.text} starts</span>
          <span className="h-px flex-1 bg-border" aria-hidden />
        </p>
      );
    case "failure":
      return (
        <p
          role="alert"
          className="rounded-xl bg-destructive-tint px-3 py-2 text-ui whitespace-pre-wrap text-destructive"
        >
          {plainError(row.text)}
        </p>
      );
  }
}

const TOOL_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  bash_manage: Terminal,
  read: FileText,
  start_worker: UserPlus,
  close_worker: UserMinus,
  message: MessageSquare,
  close: ListChecks,
  report_output: PackageCheck,
  keep_output: PackageCheck,
  change_outputs: ListChecks,
  activity: Activity,
  segment_sam: Wand,
};

function StepView({ step, links }: { step: Step; links?: AgentLinks }) {
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
          Icon={TOOL_ICON[step.name] ?? Terminal}
          title={
            <span className={step.name === "bash" ? "font-mono text-meta" : ""}>
              {step.title}
              {step.target && (
                <>
                  {" "}
                  {links?.names.has(step.target) ? (
                    <button
                      type="button"
                      onClick={() => links.open(step.target as string)}
                      className="relative z-10 font-mono text-primary-text underline underline-offset-2"
                    >
                      {step.target}
                    </button>
                  ) : (
                    <span className="font-mono">{step.target}</span>
                  )}
                </>
              )}
            </span>
          }
          status={step.status}
          expand={() => <ToolBody step={step} />}
        />
      );
  }
}

/** The tail of `text`, and whether it was cut. */
const tail = (text: string) =>
  text.length > SHOWN_CHARS
    ? { text: `…${text.slice(-SHOWN_CHARS)}`, cut: true }
    : { text, cut: false };

function ToolBody({ step }: { step: ToolStep }) {
  const command = (step.input as { command?: unknown } | undefined)?.command;
  const input = tail(
    step.name === "bash" && typeof command === "string"
      ? command
      : (JSON.stringify(step.input, null, 2) ?? ""),
  );
  const output = step.output === undefined ? undefined : tail(step.output);
  return (
    <div className="grid gap-1.5">
      <Pre>{input.text}</Pre>
      {output && (
        <Pre tone={step.status === "error" ? "error" : undefined}>
          {output.text || "(no output)"}
        </Pre>
      )}
      {(step.truncated || input.cut || output?.cut) && (
        <p className="text-meta text-muted-foreground">
          Shortened: part of the {output?.cut || step.truncated ? "output" : "call"} is not shown.
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

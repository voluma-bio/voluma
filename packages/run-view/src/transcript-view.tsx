/**
 * One agent's rows (`transcript.ts`) as a thread: its words stay visible (in the Conversation each
 * turn's first words carry "The AI" and the time), and so do the calls that change results; reasoning and other runs of tool calls fold closed under a short label, their
 * bodies built on first open; what the agent was told folds quieter still. A working thread ends
 * in a live line: the call it is in, or (the Conversation) its newest status line in words. A
 * screen's own rows (`slot` rows) render as it says, with what main got with your message under
 * yours.
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
import { clockOf } from "./run-status";
import type { Row, Step, ToolStep } from "./transcript";

/**
 * The agents a name in the thread can open: the names that are agents, and what opening one does.
 * With `ids` (main's Conversation), a "Started worker" row also expands into that worker's thread.
 */
export type AgentLinks = {
  names: ReadonlySet<string>;
  open: (name: string) => void;
  /** A worker's thread ids, by any name it answers to. */
  ids?: (name: string) => readonly string[] | undefined;
};

/** Most of a call's arguments or output shown when its fold opens; the tail is kept. */
const SHOWN_CHARS = 8000;

export function TranscriptView({
  rows,
  links,
  worker,
  slot,
  live,
  empty,
}: {
  rows: Row[];
  links?: AgentLinks;
  /** A started worker's thread, shown when its "Started worker" row is opened; built on open. */
  worker?: (name: string) => ReactNode;
  /** Renders a `slot` row by its id. */
  slot?: (id: string) => ReactNode;
  /**
   * While the thread works: what it is doing now, for the live line at the end ("" when it names
   * nothing); `words` when it is a sentence, not a call's title; `quiet` when nothing works yet
   * (no pulse).
   */
  live?: { text: string; words?: boolean; quiet?: boolean } | null;
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
              {row.kind === "slot" ? (
                <>
                  {slot?.(row.id)}
                  {row.got !== undefined && (
                    <div className="mt-1">
                      <Told label="What the AI got with your message" text={row.got} />
                    </div>
                  )}
                </>
              ) : (
                <RowView row={row} links={links} worker={worker} />
              )}
            </li>
          ))}
        </ol>
      )}
      {live && (
        <p className="mt-3 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          <span
            className={`size-2 shrink-0 rounded-full ${
              live.quiet ? "bg-muted-foreground" : "bg-info motion-safe:animate-pulse"
            }`}
            aria-hidden
          />
          <span className={`min-w-0 truncate ${live.words ? "text-ui" : "font-mono"}`}>
            {live.text || <span className="sr-only">Working</span>}
          </span>
        </p>
      )}
    </div>
  );
}

type StepProps = { links?: AgentLinks; worker?: (name: string) => ReactNode };

function RowView({ row, links, worker }: StepProps & { row: Exclude<Row, { kind: "slot" }> }) {
  switch (row.kind) {
    case "prose":
      return row.head ? (
        <div className="grid gap-1">
          <p className="flex items-baseline gap-2 text-meta">
            <span className="font-semibold">The AI</span>
            <span className="text-muted-foreground">{clockOf(row.at)}</span>
          </p>
          <Markdown text={row.text} className="text-ui" agents={links} />
        </div>
      ) : (
        <Markdown text={row.text} className="text-ui" agents={links} />
      );
    case "process":
      return (
        <ProcessDisclosure label={row.label}>
          <div className="space-y-1">
            {row.steps.map((s) => (
              <StepView key={s.id} step={s} links={links} worker={worker} />
            ))}
          </div>
        </ProcessDisclosure>
      );
    case "step":
      return <StepView step={row.step} links={links} worker={worker} />;
    case "brief":
      return <Told label={row.label} text={row.text} />;
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

/** What a thread was handed, folded quieter than its own steps. */
function Told({ label, text }: { label: string; text: string }) {
  return (
    <ProcessDisclosure label={label} quiet>
      <Markdown text={text} className="rounded-lg bg-muted px-3 py-2 text-ui" />
    </ProcessDisclosure>
  );
}

/** The first line of a worker's brief: what it is for. */
function firstLine(input: unknown): string | undefined {
  const brief = (input as { brief?: unknown } | undefined)?.brief;
  if (typeof brief !== "string") return undefined;
  return (
    brief
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? undefined
  );
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

function StepView({ step, links, worker }: StepProps & { step: Step }) {
  switch (step.kind) {
    case "reasoning":
      return (
        <ActivityRow Icon={Brain} quietIcon proseClassName="italic text-fg-subtle">
          <Markdown text={step.text} />
        </ActivityRow>
      );
    case "note":
      return <ActivityRow Icon={Cog} title={step.text} status={step.failed ? "error" : "done"} />;
    case "tool": {
      const started =
        step.name === "start_worker" && step.target && worker ? step.target : undefined;
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
          subtitle={step.name === "start_worker" ? firstLine(step.input) : undefined}
          status={step.status}
          expand={() =>
            started && worker ? (
              <div className="ml-1 border-l border-border pl-3">{worker(started)}</div>
            ) : (
              <ToolBody step={step} />
            )
          }
        />
      );
    }
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

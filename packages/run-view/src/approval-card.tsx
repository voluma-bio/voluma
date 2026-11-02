/**
 * A call the run's main AI holds for the researcher's yes, inside the conversation (review.md,
 * "Approvals"): what it would do in code's words and the outputs it makes out of date, Yes and No
 * with the researcher's own words, then the answer and how the call ended. The answer is the
 * API's to record; this only shows it. Data comes in as props (`approvalWords` names the call);
 * the outputs review's conversation shows it.
 */
import { Button, StatusMark, TextField } from "@voluma/ui";
import { useState } from "react";
import { Markdown } from "./chat/markdown";

export type ApprovalCardProps = {
  /** What the call is, in words: "Start a worker". */
  title: string;
  /** What it would do, as code wrote it. */
  summary: string;
  /** The outputs it makes out of date if it runs, by name; absent when the request names none. */
  outOfDate?: readonly string[];
  /** The yes button's words: "Yes, start fix-labels". */
  yes?: string;
  /** The researcher's answer, once given; `time` as the chat shows times. */
  answer?: { answer: "yes" | "no"; text?: string; time: string };
  /**
   * How the call closed: it ran (`done`), was refused when it ran (`refused`), or was withdrawn
   * (main closed the run, or it was cancelled) with or without an answer.
   */
  settled?: "done" | "refused" | "withdrawn";
  /** Yes or No with the words typed; absent, no answer can be given here (`readOnly` says why). */
  onAnswer?: (answer: "yes" | "no", text: string) => void;
  /** The answer being saved. */
  pending?: "yes" | "no";
  readOnly?: string;
  /** What went wrong with the last answer. */
  error?: string;
};

const SETTLED = {
  done: { status: "done", label: "Done" },
  refused: { status: "stopped", label: "Couldn't be done" },
} as const;

export function ApprovalCard({
  title,
  summary,
  outOfDate,
  yes = "Yes",
  answer,
  settled,
  onAnswer,
  pending,
  readOnly,
  error,
}: ApprovalCardProps) {
  const [words, setWords] = useState("");
  const open = !answer && !settled;
  return (
    <article
      aria-label={title}
      className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg bg-card text-sm inset-ring inset-ring-line-strong"
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="font-semibold">{title}</h3>
        {open ? (
          <span className="text-xs text-muted-foreground">waits for your answer</span>
        ) : settled === "withdrawn" ? (
          // Not a failure: main moved on without it.
          <span className="text-xs text-muted-foreground">withdrawn</span>
        ) : settled ? (
          <StatusMark status={SETTLED[settled].status} label={SETTLED[settled].label} />
        ) : (
          <span className="text-xs text-muted-foreground">answered</span>
        )}
      </header>
      <div className="grid gap-1.5 px-3 py-2">
        <Markdown text={summary} className="text-sm" />
        {outOfDate && outOfDate.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Out of date if it runs: <span className="text-foreground">{outOfDate.join(", ")}</span>
          </p>
        )}
      </div>
      {open ? (
        <div className="grid gap-2 border-t border-border px-3 py-2">
          <TextField
            label="Your words to the AI, optional"
            hideLabel
            placeholder="Add a reason or a detail (optional)"
            maxLength={10_000}
            value={words}
            disabled={!onAnswer || !!pending}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!onAnswer || !!pending}
              onClick={() => onAnswer?.("yes", words.trim())}
            >
              {pending === "yes" ? "Saving…" : yes}
            </Button>
            <Button
              size="sm"
              disabled={!onAnswer || !!pending}
              onClick={() => onAnswer?.("no", words.trim())}
            >
              {pending === "no" ? "Saving…" : "No"}
            </Button>
            {readOnly && <span className="text-xs text-muted-foreground">{readOnly}</span>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : (
        answer && (
          <p className="border-t border-border px-3 py-2 text-muted-foreground">
            You said <span className="font-semibold text-foreground">{answer.answer}</span> at{" "}
            {answer.time}
            {answer.text ? `: ${answer.text}` : "."}
          </p>
        )
      )}
    </article>
  );
}

/** A held call in words, by the tool main called: what it is, and what Yes says. */
export function approvalWords(tool: string, args: unknown): { title: string; yes: string } {
  const name = (args as { name?: unknown } | null)?.name;
  switch (tool) {
    case "start_worker":
      return {
        title: "Start a worker",
        yes: typeof name === "string" ? `Yes, start ${name}` : "Yes, start it",
      };
    case "report_output":
      return { title: "Publish a new version", yes: "Yes, publish it" };
    case "change_outputs":
      return { title: "Change the final outputs", yes: "Yes, change them" };
    case "keep_output":
      return { title: "Keep as they are", yes: "Yes, keep them" };
    default:
      return { title: tool, yes: "Yes" };
  }
}

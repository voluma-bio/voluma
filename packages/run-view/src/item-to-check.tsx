/**
 * One item waiting for a person's decision: which task it belongs to, what the AI says about it,
 * what the second AI check found, the value it affects, and the two decisions (Looks right,
 * Something's wrong). The decision lives here only: other places (the AI panel, the report) refer
 * to the item, never draw it again. Data comes in as props; the scan review's To check panel shows
 * it today.
 */
import { Button, cx, StatusGlyph, StatusMark } from "@voluma/ui";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

export type ItemToCheckProps = {
  /** The task it belongs to, named above the title. */
  task: string;
  /** What to look at; none when the task's name says it. */
  title?: string;
  /** What the AI says about it. */
  text: string;
  /** The second AI check's sentence about it, quieter. */
  found?: ReactNode;
  /** The value it affects: a `Readout`. */
  value?: ReactNode;
  /** A QC image or other evidence, under the text. */
  evidence?: ReactNode;
  /**
   * `open` takes a decision; `accepted` was decided Looks right; `info` is a task left To check
   * with nothing to accept (its check sent it back, a value is missing): only Something's wrong.
   */
  state: "open" | "accepted" | "info";
  /** Looks right; absent, the button is off and `readOnly` says why beside it. */
  onAccept?: () => void;
  accepting?: boolean;
  /** Why no decision can be made here (an example run, a run still going). */
  readOnly?: string;
  /** Something's wrong: tell the AI what should change. */
  onWrong?: () => void;
  /** What went wrong with the last decision. */
  error?: string;
  className?: string;
};

export function ItemToCheck({
  task,
  title,
  text,
  found,
  value,
  evidence,
  state,
  onAccept,
  accepting = false,
  readOnly,
  onWrong,
  error,
  className,
}: ItemToCheckProps) {
  return (
    <article
      aria-label={title ?? task}
      className={cx(
        "grid gap-2 rounded-lg bg-card p-3.5 inset-ring inset-ring-line-strong",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusGlyph status={state === "accepted" ? "done" : "check"} className="size-3" />
        {task}
      </p>
      {title && <h3 className="text-base leading-snug font-semibold">{title}</h3>}
      {text && <p className="text-sm leading-relaxed">{text}</p>}
      {found && <div className="text-sm leading-relaxed text-muted-foreground">{found}</div>}
      {value}
      {evidence}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {state === "accepted" ? (
          <StatusMark status="done" label="Looked right" />
        ) : (
          <>
            {state === "open" && (
              <Button variant="primary" disabled={!onAccept || accepting} onClick={onAccept}>
                <Check aria-hidden />
                {accepting ? "Saving…" : "Looks right"}
              </Button>
            )}
            {onWrong && <Button onClick={onWrong}>Something's wrong</Button>}
            {readOnly && <span className="text-xs text-muted-foreground">{readOnly}</span>}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

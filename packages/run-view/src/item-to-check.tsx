/**
 * One item waiting for a person's decision: where it is (its task, or its scan), what the AI says about it,
 * what the second AI check found, the value it affects, and the two decisions (Looks right,
 * Something's wrong). The decision lives here only: other places (the AI panel, the report) refer
 * to the item, never draw it again. Data comes in as props; the scan review's To check panel and
 * the study's To check page show it.
 */
import { Button, cx, StatusGlyph, StatusMark } from "@voluma/ui";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

export type ItemToCheckProps = {
  /**
   * Where it is, named above the title: its task, or its scan in a list of one check across
   * scans. Whichever the list around it doesn't already say.
   */
  context: string;
  /** What to look at; none when `context` says it. */
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
  /** The page's own way in after the decisions, such as the study's "Review in 3D". */
  actions?: ReactNode;
  /** What went wrong with the last decision. */
  error?: string;
  className?: string;
};

export function ItemToCheck({
  context,
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
  actions,
  error,
  className,
}: ItemToCheckProps) {
  return (
    <article
      aria-label={title ?? context}
      className={cx(
        "grid gap-2 rounded-lg bg-card p-3.5 inset-ring inset-ring-line-strong",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusGlyph status={state === "accepted" ? "done" : "check"} className="size-3" />
        {context}
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
        {actions}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

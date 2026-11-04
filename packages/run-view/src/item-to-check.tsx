/**
 * One To check item waiting for a person's decision: what the AI asks (which output to check, its
 * own or one it rests on, and what to look at), Looks right with what it commits to, and the
 * page's other actions. The decision lives here only: other places refer to the item, never draw
 * it again. Data comes in as props; the input review's output report shows it.
 */
import { Button, cx, StatusGlyph, StatusMark } from "@voluma/ui";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

export type ItemToCheckProps = {
  /** What is asked, above the title: "The AI asks you to check Bone labels, …". */
  context: string;
  /** What to look at; none when `context` says it. */
  title?: string;
  /** `open` takes a decision; `accepted` was decided Looks right. */
  state: "open" | "accepted";
  /** Looks right; absent, the button is off and `readOnly` says why beside it. */
  onAccept?: () => void;
  accepting?: boolean;
  /** Why no decision can be made here (an example run, a run still going). */
  readOnly?: string;
  /** The page's own actions after the decision, such as telling the AI. */
  actions?: ReactNode;
  /** What went wrong with the last decision. */
  error?: string;
  className?: string;
};

export function ItemToCheck({
  context,
  title,
  state,
  onAccept,
  accepting = false,
  readOnly,
  actions,
  error,
  className,
}: ItemToCheckProps) {
  return (
    <article
      aria-label={title ?? context}
      className={cx(
        "grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg bg-card p-3.5 inset-ring inset-ring-line-strong",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusGlyph status={state === "accepted" ? "done" : "check"} className="size-3" />
        {context}
      </p>
      {title && <h3 className="text-base leading-snug font-semibold">{title}</h3>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {state === "accepted" ? (
          <StatusMark status="done" label="Looked right" />
        ) : (
          <>
            <Button variant="primary" disabled={!onAccept || accepting} onClick={onAccept}>
              <Check aria-hidden />
              {accepting ? "Saving…" : "Looks right"}
            </Button>
            {readOnly && <span className="text-xs text-muted-foreground">{readOnly}</span>}
          </>
        )}
        {actions}
      </div>
      {state === "open" && onAccept && (
        <p className="text-xs text-muted-foreground">
          Looks right closes this check and keeps the result as it is.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

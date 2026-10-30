/**
 * Something waiting for a person's decision: one open check on one scan's result. It says what
 * the AI flagged (the title), where (the scan or the task, `context`), and why (`detail`), and
 * offers the decision: "Looks right" accepts the check against the result's revision through
 * `useAcceptCheck`, so its error reads the same everywhere. The page adds its own ways in
 * (`children`: "Review in 3D", "Something's wrong").
 *
 * `revisionId` is the completed result the check belongs to; without one, or `readOnly` (an
 * example study answers 403), the decision is disabled with its reason beside it.
 */
import { useAcceptCheck } from "@voluma/api-client/query";
import { Button, cx, Readout, type ReadoutValue, StatusGlyph } from "@voluma/ui";
import type { ReactNode } from "react";

export type ItemToCheckProps = {
  runId: string;
  revisionId: string | undefined;
  taskId: string;
  checkId: string;
  /** What names it in its list: the check's title, or the scan when the list is one check's. */
  title: string;
  /** More of where it is: the task, or the scan, whichever the list and title don't say. */
  context?: ReactNode;
  /** Why the check was raised, in the AI's sentence. */
  detail?: string;
  /** The values it affects. */
  values?: ReadoutValue[];
  readOnly?: boolean;
  /** The page's other actions, after "Looks right". */
  children?: ReactNode;
  className?: string;
};

export function ItemToCheck({
  runId,
  revisionId,
  taskId,
  checkId,
  title,
  context,
  detail,
  values,
  readOnly = false,
  children,
  className,
}: ItemToCheckProps) {
  const accept = useAcceptCheck(runId, revisionId);
  const accepted = accept.isSuccess;
  return (
    <article aria-label={title} className={cx("grid gap-1.5 py-2.5", className)}>
      <header className="flex min-w-0 items-baseline gap-2">
        <StatusGlyph status={accepted ? "done" : "check"} className="translate-y-0.5" />
        <h3 className="m-0 min-w-0 text-base font-medium">{title}</h3>
        {context && <span className="truncate text-sm text-muted-foreground">{context}</span>}
      </header>
      {detail && <p className="m-0 pl-5.5 text-sm text-pretty text-muted-foreground">{detail}</p>}
      {values && values.length > 0 && <Readout values={values} className="ml-5.5" />}
      <div className="flex flex-wrap items-center gap-2 pt-0.5 pl-5.5">
        <Button
          size="sm"
          disabled={readOnly || !revisionId || accept.isPending || accepted}
          reason={
            readOnly
              ? "An example study can't be changed."
              : !revisionId
                ? "Decide on this one in the scan review."
                : undefined
          }
          onClick={() => accept.mutate({ checkId, taskId })}
        >
          {accept.isPending ? "Saving…" : accepted ? "Accepted" : "Looks right"}
        </Button>
        {children}
      </div>
      {accept.isError && (
        <p role="alert" className="m-0 pl-5.5 text-sm text-destructive">
          {accept.error.message}
        </p>
      )}
    </article>
  );
}

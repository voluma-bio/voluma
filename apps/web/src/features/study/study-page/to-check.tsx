/**
 * The study's To check tab: every open check of each scan's latest result, one heading per kind
 * (task and check title, `checkKinds`), one aligned row per item. "Looks right" accepts the check
 * against that result's revision; "Open in 3D" hands the row's kind, in this order, to
 * `openChecks`, and "Go through all N" the same queue from its start. There are no fix actions: corrections have no backend yet.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, acceptCheck } from "@voluma/api-client";
import type { StudyDetail, StudyScanDetail, ToCheckItem } from "@voluma/contracts/study";
import { Button } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { Link } from "react-router";
import { checkKinds, type OpenChecks, scanHref, scanMeta } from "./study-model";

export function ToCheck({
  detail,
  workflow,
  openChecks,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  openChecks: OpenChecks;
}) {
  const kinds = checkKinds(detail, workflow);
  if (kinds.length === 0)
    return (
      <p className="mx-auto max-w-3xl text-ui text-muted-foreground">
        {detail.scans.some((s) => s.resultRunId !== null)
          ? "Nothing to check. Every finished scan's checks are done."
          : "Nothing yet. Items appear here as each scan's run finishes."}
      </p>
    );
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      {kinds.map((kind) => {
        const queue = kind.items.map(({ item }) => item);
        const scans = new Set(kind.items.map((i) => i.scan.scan.inputId)).size;
        return (
          <section key={kind.key} aria-label={`${kind.taskTitle}, ${kind.title}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
              <h2 className="m-0 text-sm font-semibold">{kind.taskTitle}</h2>
              <span className="text-ui text-muted-foreground">{kind.title}</span>
              <span className="text-meta text-fg-subtle tabular-nums">
                {scans} {scans === 1 ? "scan" : "scans"}
              </span>
              {queue.length > 1 && (
                <Button size="sm" className="ml-auto" onClick={() => openChecks(queue, 0)}>
                  Go through all {kind.items.length} in 3D
                </Button>
              )}
            </div>
            <ul className="m-0 list-none p-0">
              {kind.items.map(({ scan, item }, i) => (
                <CheckRow
                  key={`${item.runId}/${item.checkId}`}
                  scan={scan}
                  item={item}
                  readOnly={detail.study.example}
                  onOpen={() => openChecks(queue, i)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function CheckRow({
  scan,
  item,
  readOnly,
  onOpen,
}: {
  scan: StudyScanDetail;
  item: ToCheckItem;
  /** The seeded example: accepting answers 403, so the button starts disabled. */
  readOnly: boolean;
  onOpen: () => void;
}) {
  const client = useQueryClient();
  // The study read's items belong to the scan's latest completed result, whose revision the
  // accept names; a result that changed since answers 409 and the refetch shows the new one.
  const revision = scan.runs.find((r) => r.id === item.runId)?.review?.revisionId;
  const accept = useMutation({
    mutationFn: () =>
      acceptCheck(item.runId, item.checkId, {
        baseRevisionId: revision as string,
        taskId: item.taskId,
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ["study"] }),
  });
  const path = scanHref(scan);
  return (
    <li className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line-subtle py-2.5 max-[760px]:grid-cols-[minmax(0,1fr)_auto]">
      {path ? (
        <Link to={path} className="truncate font-mono text-ui hover:underline">
          {scan.scan.subject}
        </Link>
      ) : (
        <span className="truncate font-mono text-ui">{scan.scan.subject}</span>
      )}
      <span className="grid gap-0.5 text-ui max-[760px]:order-last max-[760px]:col-span-2">
        {item.detail && <span className="text-pretty">{item.detail}</span>}
        <span className="text-meta text-muted-foreground">{scanMeta(scan).join(", ")}</span>
        {accept.isError && (
          <span role="alert" className="block text-destructive">
            {acceptError(accept.error)}
          </span>
        )}
      </span>
      <span className="flex justify-end gap-2">
        <Button
          size="sm"
          disabled={readOnly || !revision || accept.isPending || accept.isSuccess}
          onClick={() => accept.mutate()}
        >
          {accept.isPending ? "Saving…" : accept.isSuccess ? "Accepted" : "Looks right"}
        </Button>
        <Button size="sm" onClick={onOpen}>
          Open in 3D
        </Button>
      </span>
    </li>
  );
}

function acceptError(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "The result changed since this loaded. It's up to date now.";
  }
  return "Couldn't save that. Try again.";
}

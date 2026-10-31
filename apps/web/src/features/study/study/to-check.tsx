/**
 * The study's To check page: every open check of each scan's latest result, the study's queue of
 * decisions. By scan (most to check first): a scan's row opens to its summary graph and its
 * items. By issue: one row per kind of check (task and title, `checkKinds`), opening to that
 * check on each scan. Each item is an `ItemToCheck` ("Looks right"); "Review in 3D" opens the
 * scan's review.
 */

import { useAcceptCheck } from "@voluma/api-client/query";
import type { StudyScanDetail, ToCheckItem } from "@voluma/contracts/study";
import { ItemToCheck, itemHref, plural, scanLabel, TaskGraph } from "@voluma/run-view";
import {
  Button,
  Count,
  EmptyState,
  List,
  PageHead,
  Row,
  RowLink,
  SegmentedControl,
  StatusMark,
} from "@voluma/ui";
import { Box as Cube } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { linkTo } from "../link";
import { useStudy } from "./study-layout";
import { byMostToCheck, checkKinds, checkTitles, reviewHref, scanGraph } from "./study-model";

type By = "scan" | "issue";

/** An opened row's items: cards in a column, as wide as the scan review's own. */
const ITEMS = "grid max-w-2xl gap-2 pb-3";

export function ToCheckPage() {
  const { detail, workflow } = useStudy();
  const [search, setSearch] = useSearchParams();
  const by: By = search.get("by") === "issue" ? "issue" : "scan";
  const scans = byMostToCheck(detail.scans);
  const items = scans.reduce((n, s) => n + s.toCheck.length, 0);
  const first = scans[0];
  const firstHref = first && reviewHref(first);
  const anyDone = detail.scans.some((s) => s.resultRunId !== null);

  return (
    <>
      <PageHead
        title="To check"
        count={items > 0 && <Count tone="check">{items}</Count>}
        subtitle={items > 0 && `${plural(items, "item")} across ${plural(scans.length, "scan")}`}
        actions={
          firstHref && (
            <Button asChild variant="primary">
              <Link to={firstHref}>
                <Cube aria-hidden />
                Review {first.scan.subject}
              </Link>
            </Button>
          )
        }
      />
      {items === 0 ? (
        <EmptyState title={anyDone ? "Nothing to check" : "Nothing to check yet"}>
          {anyDone
            ? "Every finished scan's checks are done."
            : "Items appear here as each scan's run finishes."}
        </EmptyState>
      ) : (
        <section aria-labelledby="queue">
          <header className="flex h-(--panel-head-h) items-center gap-3 border-b border-border px-4">
            <h2 id="queue" className="m-0 text-sm font-semibold">
              {by === "scan" ? "By scan, most to check first" : "By issue"}
            </h2>
            <SegmentedControl<By>
              label="Group items"
              className="ml-auto"
              value={by}
              onValueChange={(v) => setSearch(v === "scan" ? {} : { by: v }, { replace: true })}
              options={[
                { value: "scan", label: "By scan" },
                { value: "issue", label: "By issue" },
              ]}
            />
          </header>
          {by === "scan" ? (
            <List columns="6rem 7rem auto" label="Scans with items to check">
              {scans.map((scan) => (
                <ScanRow key={scan.scan.inputId} scan={scan} />
              ))}
            </List>
          ) : (
            <List columns="auto" label="Issues to check">
              {checkKinds(detail, workflow).map((kind) => (
                <Row
                  key={kind.key}
                  title={kind.title}
                  subtitle={`${kind.taskTitle}, ${plural(new Set(kind.items.map((i) => i.scan.scan.inputId)).size, "scan")}`}
                  cells={[
                    <StatusMark key="n" status="check" label={`${kind.items.length} to check`} />,
                  ]}
                >
                  <div className={ITEMS}>
                    {kind.items.map(({ scan, item }) => (
                      <Item
                        key={`${item.runId}/${item.checkId}`}
                        scan={scan}
                        item={item}
                        context={scanLabel(scan.scan)}
                      />
                    ))}
                  </div>
                </Row>
              ))}
            </List>
          )}
        </section>
      )}
    </>
  );
}

/** A scan with items: opens to its tasks at summary size, then its items. */
function ScanRow({ scan }: { scan: StudyScanDetail }) {
  const { workflow } = useStudy();
  const href = reviewHref(scan);
  const titles = checkTitles(scan.toCheck);
  const cells = [
    <span key="group" className="text-sm text-muted-foreground">
      {scan.scan.group}
    </span>,
    <StatusMark key="n" status="check" label={`${scan.toCheck.length} to check`} />,
    href && (
      <Button key="3d" asChild size="sm">
        <Link to={href}>
          <Cube aria-hidden />
          Review in 3D
        </Link>
      </Button>
    ),
  ];
  const body = (
    <>
      <div className="overflow-x-auto py-2">
        <TaskGraph size="summary" tasks={scanGraph(scan, workflow)} className="min-w-[40rem]" />
      </div>
      <div className={ITEMS}>
        {scan.toCheck.map((item) => (
          <Item
            key={item.checkId}
            scan={scan}
            item={item}
            context={workflow.taskTitle(item.taskId)}
            title={item.title}
          />
        ))}
      </div>
    </>
  );
  return href ? (
    <RowLink to={linkTo(href)} title={scanLabel(scan.scan)} subtitle={titles} cells={cells}>
      {body}
    </RowLink>
  ) : (
    <Row title={scanLabel(scan.scan)} subtitle={titles} cells={cells}>
      {body}
    </Row>
  );
}

/**
 * One open check, under its scan (titled by the check, its task above) or under its issue (its
 * scan above, the issue's row says the check). "Looks right" accepts it against the revision the
 * study read's items belong to, the scan's latest completed result; a result that changed since
 * answers 409, and the refetch shows the new one.
 */
function Item({
  scan,
  item,
  context,
  title,
}: {
  scan: StudyScanDetail;
  item: ToCheckItem;
  context: string;
  title?: string;
}) {
  const { detail } = useStudy();
  const revision = scan.runs.find((r) => r.id === item.runId)?.review?.revisionId;
  const accept = useAcceptCheck(item.runId, revision);
  const readOnly = detail.study.example
    ? "Example studies can't be changed."
    : !revision
      ? "Decide on this one in the scan review."
      : undefined;
  return (
    <ItemToCheck
      context={context}
      title={title}
      text={item.detail}
      state={accept.isSuccess ? "accepted" : "open"}
      onAccept={
        readOnly ? undefined : () => accept.mutate({ checkId: item.checkId, taskId: item.taskId })
      }
      accepting={accept.isPending}
      readOnly={readOnly}
      error={accept.error?.message}
      actions={
        <Button asChild variant="ghost">
          <Link to={itemHref(item)}>
            <Cube aria-hidden />
            Review {scan.scan.subject} in 3D
          </Link>
        </Button>
      }
    />
  );
}

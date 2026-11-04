/**
 * A sample's bar: one segment per measurement of the workflow, in catalog order, each segment the
 * state `segmentOf` reads from the sample's own data. It shows where in
 * the measurements the trouble sits and how far a running sample is; its accessible name (and
 * hover) counts each state. Reported is green at half strength so a finished study doesn't shout.
 */
import type { StudyInputDetail } from "@voluma/contracts/study";
import { cx } from "@voluma/ui";
import { type Measurement, SEGMENT_WORD, type Segment, segmentOf } from "./study-model";

export const SEGMENT_LOOK: Record<Segment, string> = {
  reported: "bg-done-solid opacity-50",
  check: "bg-check-solid",
  making: "bg-info-solid",
  stale: "bg-idle",
  waiting: "bg-muted shadow-[inset_0_0_0_1px_var(--border)]",
  missing: "shadow-[inset_0_0_0_1.5px_var(--line-strong)]",
  stopped: "bg-destructive-solid",
};

const ORDER: Segment[] = ["check", "stale", "making", "stopped", "missing", "reported", "waiting"];

export function SampleBar({
  input,
  measurements,
}: {
  input: StudyInputDetail;
  measurements: Measurement[];
}) {
  const states = measurements.map((o) => segmentOf(input, o));
  const counts = new Map<Segment, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  const name = ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${SEGMENT_WORD[s].toLowerCase()}`)
    .join(", ");
  return (
    <span role="img" aria-label={name} title={name} className="flex items-center gap-px">
      {states.map((state, i) => (
        <i
          key={measurements[i]?.id}
          className={cx("block h-2.5 w-1 rounded-[1px]", SEGMENT_LOOK[state])}
        />
      ))}
    </span>
  );
}

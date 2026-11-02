/**
 * A sample's bar: one segment per measurement of the workflow, in task order, a 2 px gap between
 * tasks, each segment the state `segmentOf` reads from the sample's own data. It shows where in
 * the measurements the trouble sits and how far a running sample is; its accessible name (and
 * hover) counts each state. Reported is green at half strength so a finished study doesn't shout.
 */
import type { StudyInputDetail } from "@voluma/contracts/study";
import { cx } from "@voluma/ui";
import { SEGMENT_WORD, type Section, type Segment, segmentOf } from "./study-model";

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

export function SampleBar({ input, sections }: { input: StudyInputDetail; sections: Section[] }) {
  const states = sections.map((s) => s.outputs.map((o) => segmentOf(input, o)));
  const counts = new Map<Segment, number>();
  for (const s of states.flat()) counts.set(s, (counts.get(s) ?? 0) + 1);
  const name = ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${SEGMENT_WORD[s].toLowerCase()}`)
    .join(", ");
  return (
    <span role="img" aria-label={name} title={name} className="flex items-center gap-0.5">
      {states.map((section, i) => (
        <span key={sections[i]?.taskId} className="flex gap-px">
          {section.map((state, j) => (
            <i
              key={sections[i]?.outputs[j]?.id}
              className={cx("block h-2.5 w-1 rounded-[1px]", SEGMENT_LOOK[state])}
            />
          ))}
        </span>
      ))}
    </span>
  );
}

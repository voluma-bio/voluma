/**
 * The study panel: the study's name, how far its inputs are (one Progress cell per input) and its
 * inputs by group, each with its state, linking to the input's review. It is the left panel one
 * click away on every study page and in the input review, so both render it from here. Also the
 * input-level facts both read from a `StudyDetail`: an input's status, knee and group.
 */
import { inputNeedsYou } from "@voluma/contracts/review-state";
import type { StudyDetail, StudyInputDetail, StudyRunSummary } from "@voluma/contracts/study";
import {
  INPUT_WORD,
  type LinkTo,
  List,
  Progress,
  Row,
  RowLink,
  type Status,
  StatusMark,
} from "@voluma/ui";
import { liveStatus, needsYouText, plural } from "./run-status";

type InputStatus = { label: string; status: Status; open: number };

/** What needs a person on an input (`inputNeedsYou`), as Studies counts it too. */
export const needsYouOf = (input: StudyInputDetail) =>
  inputNeedsYou(input.review, input.acceptable.length);

/**
 * An input's status: its newest run's (`runStatus`, which reads To check from the items that need
 * a person), with "Task N of M" while it runs; "Not started" without a run. Its values may come
 * from an older completed run.
 */
export function inputStatus(input: StudyInputDetail): InputStatus {
  const [run] = input.runs;
  if (!run) return { label: "Not started", status: "waiting", open: 0 };
  // The input's `review` is its newest run's, of either loop (a `Run` has one for the task loop only).
  const { label, status } = liveStatus({ ...run, review: input.review });
  const open = status === "check" ? needsYouOf(input) : 0;
  return { label: open > 0 ? needsYouText(open, run.harness) : label, status, open };
}

/** An input's knee (`attributes.knee`, as `/new`'s intake stores it), or null. */
export function kneeOf(input: StudyInputDetail): string | null {
  const knee = input.member.attributes.knee;
  return typeof knee === "string" && knee ? knee : null;
}

/** The row an input sits on: its group, or one shared row when no input of the study has one. */
export const groupOf = (input: StudyInputDetail, grouped: boolean) =>
  input.member.group ?? (grouped ? "No group" : `All ${INPUT_WORD.many}`);

/** Groups in the order their first input appears in the study. */
export function groupNames(detail: StudyDetail): string[] {
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  return [...new Set(detail.inputs.map((s) => groupOf(s, grouped)))];
}

/** A run the API or the runner is still moving: a page refetches while one is in view. */
export const isLive = (run: Pick<StudyRunSummary, "state"> | undefined) =>
  run !== undefined && run.state.status !== "ended";

/** "11 of 20 finished, 2 running". */
function finishedLine(detail: StudyDetail): string {
  const finished = detail.inputs.filter((s) => s.resultRunId !== null).length;
  const running = detail.inputs.filter((s) => s.runs[0]?.state.status === "running").length;
  return `${finished} of ${detail.inputs.length} finished${running ? `, ${running} running` : ""}`;
}

export function StudyPanel({
  detail,
  about,
  inputLink,
  current,
}: {
  detail: StudyDetail;
  /** One line under the name: what the study is, e.g. "20 knees, Mouse OA knee". */
  about: string;
  /** Where an input's row goes; `undefined` for an input with no run yet. */
  inputLink: (input: StudyInputDetail) => LinkTo | undefined;
  /** The input open in the review, drawn selected. */
  current?: string;
}) {
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-1 border-b border-border px-4 pt-3 pb-3.5">
        <p className="m-0 font-semibold">{detail.study.name}</p>
        <p className="m-0 text-sm text-muted-foreground">{about}</p>
        <Progress states={detail.inputs.map((s) => inputStatus(s).status)} className="mt-1.5" />
        <p className="m-0 text-sm text-muted-foreground">{finishedLine(detail)}</p>
      </div>
      {groupNames(detail).map((group) => {
        const inputs = detail.inputs.filter((s) => groupOf(s, grouped) === group);
        return (
          <section
            key={group}
            aria-label={`${group}, ${plural(inputs.length, INPUT_WORD.one, INPUT_WORD.many)}`}
            className="pt-2"
          >
            {grouped && <h3 className="m-0 px-4 pb-1 text-xs text-muted-foreground">{group}</h3>}
            <List density="compact" columns="auto" label={group}>
              {inputs.map((input) => (
                <PanelRow
                  key={input.member.inputId}
                  input={input}
                  to={inputLink(input)}
                  selected={current === input.member.inputId}
                />
              ))}
            </List>
          </section>
        );
      })}
    </div>
  );
}

function PanelRow({
  input,
  to,
  selected,
}: {
  input: StudyInputDetail;
  to: LinkTo | undefined;
  selected: boolean;
}) {
  const { label, status } = inputStatus(input);
  const knee = kneeOf(input);
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="truncate font-mono text-sm" title={input.member.subject}>
        {input.member.subject}
      </span>
      {knee && <span className="truncate font-normal text-muted-foreground">{knee} knee</span>}
      {selected && <span className="shrink-0 text-xs text-select-text">Viewing</span>}
    </span>
  );
  const cell = <StatusMark status={status} label={label} className="text-xs" />;
  return to ? (
    <RowLink to={to} title={title} cells={[cell]} selected={selected} />
  ) : (
    <Row title={title} cells={[cell]} />
  );
}

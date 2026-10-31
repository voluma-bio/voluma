/**
 * `conversation` is all The AI panel knows of a correction: an outcome missing from it leaves the
 * panel saying the AI is still redoing a task the run finished long ago. The log is run
 * 8b7ecfea's (a local mouse-OA run corrected with a real model, 2026-10-31): its events' types,
 * threads and payloads, trimmed to the ones `conversation` and `corrections` read.
 */
import { describe, expect, it } from "vitest";
import { conversation, openOffer } from "./conversation";
import { log, RUN } from "./fold-test-log";

const person = `${RUN}.person`;
const root = `${RUN}.supervisor`;
const main = `${RUN}.main`;

/** The run as it finished, before anyone wrote to it. */
function finishedRun() {
  const l = log();
  l.add("thread.started", `${root}:start`, root, {
    name: "supervisor",
    parentThreadId: null,
    kind: "supervisor",
  } as never);
  l.add("thread.ended", `${main}:call_1:finish_run`, root, {
    status: "completed",
    summary: "The AI measured the full 28-parameter mouse knee set on this scan.",
  });
  return l;
}

/** The API's writes for a message: `run.reopened`, then the message. */
function write(l: ReturnType<typeof log>, id: string, payload: object) {
  l.add("run.reopened", `${person}:${id}:reopened`, person, { by: "user_1" });
  l.add("person.message", `${person}:${id}`, person, payload as never);
}

/** The second message: the offer, then the go, as run 8b7ecfea logged them (before the redo). */
function offerAndGo(l: ReturnType<typeof log>) {
  write(l, "m3", {
    text: "The dense bone at the plateau rim (my mark P1) should be excluded from the trabecular core (ROI-2).",
    marks: [{ volumeId: "iioc/tibia-grid", point: [188, 155, 167] }],
    taskId: "trabecular-roi",
  });
  l.add("reply", `${main}:call_3:reply`, main, {
    text: "I see your P1 at the plateau rim wall. Shall I go ahead?",
    offer: { taskId: "trabecular-roi" },
  });
  l.add("thread.ended", `${main}:call_4:finish_run`, root, {
    status: "completed",
    summary:
      "Acknowledged rim exclusion request for trabecular core; offered redo and awaiting go.",
  });
  write(l, "m4", { taskId: "trabecular-roi", go: true });
  l.add("revision.started", `${person}:m4:go`, main, {
    reason: "correction",
    taskId: "trabecular-roi",
  });
  l.add("reply", `${main}:call_5:reply`, main, {
    text: "Redoing the trabecular core now to exclude that plateau rim bone at your mark and remeasure the volumes.",
  });
}

/** `offerAndGo`, then the redo's attempt of the task. */
function offerAndRedo(l: ReturnType<typeof log>) {
  offerAndGo(l);
  l.add("attempt.opened", `${RUN}.trabecular-roi.worker:open`, `${RUN}.trabecular-roi.worker`, {
    taskId: "trabecular-roi",
  });
}

const view = (l: ReturnType<typeof log>) =>
  conversation(l.events).map((m) =>
    m.from === "outcome" ? [m.from, m.status, m.redo, m.text] : [m.from, m.id],
  );

describe("conversation", () => {
  it("ends a redo with the root's closing summary, and adds nothing to a chat the reply answered", () => {
    const l = finishedRun();
    write(l, "m1", {
      text: "Is this run finished? Do not redo any task. Just confirm in one sentence.",
      taskId: "segmentation",
    });
    l.add("reply", `${main}:call_2:reply`, main, {
      text: "Yes, this run is finished with all measurements reported and checked.",
    });
    l.add("thread.ended", `${main}:call_2:finish_run`, root, {
      status: "completed",
      summary: "Run remains finished with all outputs reported; no tasks redone per request.",
    });
    offerAndRedo(l);
    expect(view(l).at(-1)?.[0]).not.toBe("outcome");
    l.add("thread.ended", `${main}:call_6:finish_run`, root, {
      status: "completed",
      summary:
        "The AI redid the trabecular core as requested so the dense plateau rim at your mark is now outside ROI-2, with TV 0.745 mm3 BV 0.166 mm3 BV/TV 22.3% verified by a second AI check; all other measurements are unchanged and the run is finished.",
    });
    expect(view(l)).toEqual([
      ["person", `${person}:m1`],
      ["agent", `${main}:call_2:reply`],
      ["person", `${person}:m3`],
      ["agent", `${main}:call_3:reply`],
      ["person", `${person}:m4`],
      ["agent", `${main}:call_5:reply`],
      [
        "outcome",
        "completed",
        "trabecular-roi",
        expect.stringContaining("now outside ROI-2, with TV 0.745 mm3"),
      ],
    ]);
  });

  it("a failed redo ends with its reason, not a summary", () => {
    const l = finishedRun();
    offerAndRedo(l);
    l.add("thread.ended", `${root}:fail`, root, { status: "failed", error: "worker crashed" });
    expect(view(l).at(-1)?.[0]).toBe("agent");
    l.add("correction.ended", `${person}:m4:ended`, person, {
      status: "failed",
      error: "The run stopped making progress.",
    });
    expect(view(l).at(-1)).toEqual([
      "outcome",
      "failed",
      "trabecular-roi",
      "The run stopped making progress.",
    ]);
  });

  it("a cancel after the root's completed end shows the cancel alone", () => {
    const l = finishedRun();
    offerAndRedo(l);
    l.add("thread.ended", `${main}:call_6:finish_run`, root, {
      status: "completed",
      summary: "Redid it.",
    });
    l.add("correction.ended", `${person}:m4:ended`, person, { status: "cancelled" });
    expect(view(l).filter((m) => m[0] === "outcome")).toEqual([
      ["outcome", "cancelled", "trabecular-roi", undefined],
    ]);
  });

  it("a message the AI ended without answering shows the summary", () => {
    const l = finishedRun();
    write(l, "m1", { text: "second message before reply" });
    l.add("thread.ended", `${main}:call_2:finish_run`, root, {
      status: "completed",
      summary: "Run remains finished; acknowledged follow-up with no further work.",
    });
    expect(view(l).at(-1)).toEqual([
      "outcome",
      "completed",
      undefined,
      "Run remains finished; acknowledged follow-up with no further work.",
    ]);
  });

  it("a go that led to no redo ends as Done, naming no redone task", () => {
    const l = finishedRun();
    offerAndGo(l);
    l.add("thread.ended", `${main}:call_6:finish_run`, root, {
      status: "completed",
      summary: "The rim is already outside ROI-2; nothing to redo.",
    });
    expect(view(l).at(-1)).toEqual([
      "outcome",
      "completed",
      undefined,
      "The rim is already outside ROI-2; nothing to redo.",
    ]);
  });

  it("an offer made during a go stays open past the correction's outcome", () => {
    const l = finishedRun();
    offerAndRedo(l);
    l.add("reply", `${main}:call_7:reply`, main, {
      text: "The cortical shell now overlaps the new core. Shall I redo it too?",
      offer: { taskId: "cortical-roi" },
    });
    l.add("thread.ended", `${main}:call_8:finish_run`, root, {
      status: "completed",
      summary: "Redid the trabecular core; offered a cortical redo.",
    });
    const items = conversation(l.events);
    expect(items.at(-1)?.from).toBe("outcome");
    expect(openOffer(items)?.id).toBe(`${main}:call_7:reply`);
    write(l, "m5", { taskId: "cortical-roi", text: "No, keep it." });
    expect(openOffer(conversation(l.events))).toBeUndefined();
  });
});

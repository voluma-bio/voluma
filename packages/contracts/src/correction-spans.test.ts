/**
 * `correctionSpans` decides what `/outputs` the runner restores or deletes; a wrong span is
 * silent and loses a researcher's files, so its shapes are pinned here.
 */
import { describe, expect, it } from "vitest";
import { correctionSpans } from "./fold";
import { log, RUN } from "./fold-test-log";

const person = `${RUN}.person`;

/** The API's writes for a message: `run.reopened` (unless `reopen` is false), then the message. */
function message(l: ReturnType<typeof log>, id: string, go: boolean, reopen = true) {
  if (reopen) l.add("run.reopened", `${person}:${id}:reopened`, person, { by: "u" });
  l.add(
    "person.message",
    `${person}:${id}`,
    person,
    go ? { go: true, taskId: "a" } : { text: "hi" },
  );
}
const rootEnds = (l: ReturnType<typeof log>, id: string) =>
  l.add("thread.ended", id, `${RUN}.supervisor`, { status: "completed" } as never);
const ended = (l: ReturnType<typeof log>, id: string) =>
  l.add("correction.ended", `${person}:${id}:ended`, person, { status: "cancelled" });
const view = (l: ReturnType<typeof log>) =>
  correctionSpans(l.events).map((s) => [s.reopenId.split(":")[1], s.closed, s.hasGo]);

describe("correctionSpans", () => {
  it("a cancel after the root's completed end still abandons the span", () => {
    const l = log();
    message(l, "m1", true);
    rootEnds(l, "root:end");
    ended(l, "m1");
    message(l, "m2", true);
    expect(view(l)).toEqual([
      ["m1", "abandoned", true],
      ["m2", "open", true],
    ]);
  });

  it("back-to-back spans: a reopen with no end between finishes the earlier one", () => {
    const l = log();
    message(l, "m1", false);
    rootEnds(l, "root:end");
    message(l, "m2", true);
    ended(l, "m2");
    message(l, "m3", false);
    expect(view(l)).toEqual([
      ["m1", "finished", false],
      ["m2", "abandoned", true],
      ["m3", "open", false],
    ]);
  });

  it("a requeue after a completed claim keeps the go stored before its reopen", () => {
    const l = log();
    message(l, "m1", false);
    rootEnds(l, "root:end");
    // A go arrived during the claim; the requeue's reopen is keyed to it and stored after it.
    message(l, "m2", true, false);
    l.add("run.reopened", `${person}:m2:reopened`, person, { by: "u" });
    const spans = correctionSpans(l.events);
    expect(view(l)).toEqual([
      ["m1", "finished", false],
      ["m2", "open", true],
    ]);
    // The first span ends where the second starts, so it does not take the go.
    expect(spans[0]?.to).toBe(spans[1]?.from);
  });

  it("a failed claim followed by a requeue: the end closes only its own span", () => {
    const l = log();
    message(l, "m1", true);
    ended(l, "m1");
    message(l, "m2", false, false);
    l.add("run.reopened", `${person}:m2:reopened`, person, { by: "u" });
    expect(view(l)).toEqual([
      ["m1", "abandoned", true],
      ["m2", "open", false],
    ]);
  });
});

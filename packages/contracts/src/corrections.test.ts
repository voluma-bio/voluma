/**
 * `corrections` decides what `/outputs` the runner restores or deletes and which go grants work;
 * a wrong span is silent and loses a researcher's files, so its shapes are pinned here.
 */
import { describe, expect, it } from "vitest";
import { corrections, goMarkerId } from "./fold";
import { log, RUN } from "./fold-test-log";

const person = `${RUN}.person`;

/** The API's writes for a message: `run.reopened`, then the message. */
function message(l: ReturnType<typeof log>, id: string, go: boolean) {
  l.add("run.reopened", `${person}:${id}:reopened`, person, { by: "u" });
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
  corrections(l.events).spans.map((s) => [s.reopenId.split(":")[1], s.closed, s.go?.taskId]);

describe("corrections", () => {
  it("a cancel after the root's completed end still abandons the span", () => {
    const l = log();
    message(l, "m1", true);
    rootEnds(l, "root:end");
    ended(l, "m1");
    message(l, "m2", true);
    expect(view(l)).toEqual([
      ["m1", "abandoned", "a"],
      ["m2", "open", "a"],
    ]);
    expect(corrections(l.events).open?.message).toBe(`${person}:m2`);
  });

  it("back-to-back spans: a reopen with no end between finishes the earlier one", () => {
    const l = log();
    message(l, "m1", false);
    rootEnds(l, "root:end");
    message(l, "m2", true);
    ended(l, "m2");
    message(l, "m3", false);
    expect(view(l)).toEqual([
      ["m1", "finished", undefined],
      ["m2", "abandoned", "a"],
      ["m3", "open", undefined],
    ]);
  });

  it("an abandoned span leaves no open correction", () => {
    const l = log();
    message(l, "m1", true);
    ended(l, "m1");
    expect(corrections(l.events).open).toBeUndefined();
  });

  it("a go is marked when main is told and redone once an attempt of its task opens", () => {
    const l = log();
    message(l, "m1", true);
    expect(corrections(l.events).open?.go).toEqual({
      taskId: "a",
      markerAt: undefined,
      redone: false,
    });
    l.add("revision.started", goMarkerId(`${person}:m1`), `${RUN}.main.1`, {
      reason: "correction",
      taskId: "a",
    });
    l.add("attempt.opened", "att", `${RUN}.a.worker`, { taskId: "a" } as never);
    expect(corrections(l.events).open?.go).toMatchObject({ markerAt: 2, redone: true });
  });

  it("the backup state follows the latest outputs event of each reopen", () => {
    const l = log();
    message(l, "m1", true);
    l.add("outputs.backed-up", "b1", `${RUN}.supervisor`, { reopenId: `${person}:m1:reopened` });
    ended(l, "m1");
    message(l, "m2", true);
    l.add("outputs.backed-up", "b2", `${RUN}.supervisor`, { reopenId: `${person}:m2:reopened` });
    l.add("outputs.restored", "r1", `${RUN}.supervisor`, { reopenId: `${person}:m1:reopened` });
    expect(corrections(l.events).spans.map((s) => s.backup)).toEqual(["restored", "backed-up"]);
  });
});

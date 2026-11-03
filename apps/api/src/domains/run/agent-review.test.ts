import { describe, expect, it } from "vitest";
import { type LateRow, lateResearcherWrite } from "./agent-review";

const row = (seq: number, type: string, payload: unknown = null, threadId = "main"): LateRow => ({
  id: `e${seq}`,
  type,
  seq,
  threadId,
  payload,
});
const rootStart = row(1, "thread.started", { parentThreadId: null });

describe("lateResearcherWrite", () => {
  it("reopens on a write stored after the claim's readSeq", () => {
    const rows = [rootStart, row(2, "thread.ended"), row(3, "person.message")];
    expect(lateResearcherWrite(rows, 2)).toBe("e3");
    expect(lateResearcherWrite([...rows, row(4, "approval.declined")], 2)).toBe("e3");
  });

  it("does not reopen on a write the claim saw", () => {
    const rows = [rootStart, row(2, "person.message"), row(3, "thread.ended")];
    expect(lateResearcherWrite(rows, 3)).toBeNull();
  });

  it("without readSeq, the root's latest end stands in", () => {
    const worker = row(5, "thread.ended", null, "worker");
    expect(
      lateResearcherWrite([rootStart, row(2, "person.message"), row(3, "thread.ended")], undefined),
    ).toBeNull();
    expect(
      lateResearcherWrite(
        [rootStart, row(2, "thread.ended"), worker, row(6, "approval.given")],
        undefined,
      ),
    ).toBe("e6");
  });

  it("ignores a write before the latest run.reopened", () => {
    const rows = [
      rootStart,
      row(2, "thread.ended"),
      row(3, "person.message"),
      row(4, "run.reopened"),
    ];
    expect(lateResearcherWrite(rows, 2)).toBeNull();
    expect(lateResearcherWrite([...rows, row(5, "person.message")], 2)).toBe("e5");
  });

  it("finds nothing with no readSeq and no root end", () => {
    expect(lateResearcherWrite([rootStart, row(2, "person.message")], undefined)).toBeNull();
  });
});

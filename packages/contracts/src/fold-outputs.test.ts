/**
 * Synthetic event sequences for `fold`: outputs routed to review blocks, the
 * plan, and references between outputs, including after another task is redone.
 */
import { describe, expect, it } from "vitest";
import { fold } from "./fold";
import { expectParses, log, need, rev, SHA, SUP, twoDone, W } from "./fold-test-log";
import type { Output } from "./output";
import type { Focus } from "./review";
import type { WorkflowPlan } from "./workflow";

describe("fold outputs", () => {
  it("measurement ids repeat across tasks; operands resolve; a dangling one is dropped", () => {
    const l = twoDone(); // a/width and b/width
    l.open("w:7:open", W, "c");
    l.measurement("w:8", W, "c", "w:7:open", "ratio", 0.5, {
      numeratorId: "a/width",
      denominatorId: "b/width",
    });
    l.measurement("w:9", W, "c", "w:7:open", "self", 1, { numeratorId: "ratio" });
    l.status("w:10", W, "c", "w:7:open", "done");
    // b is redone and no longer reports width.
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "b" });
    l.status("sup:1", SUP, "b", "w:4:open", "stale");
    l.open("w:11:open", W, "b");
    l.measurement("w:12", W, "b", "w:11:open", "depth", 2);
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    const ratio = (r: typeof r1) => need(r?.tasks ?? [], "c").measurements;
    expect(r1?.tasks.flatMap((t) => t.measurements.map((m) => m.id))).toEqual([
      "a/width",
      "b/width",
      "c/ratio",
      "c/self",
    ]);
    expect(ratio(r1)?.[0]).toMatchObject({ numeratorId: "a/width", denominatorId: "b/width" });
    expect(ratio(r1)?.[1]?.numeratorId).toBe("c/ratio");
    expect(ratio(r2)?.[0]?.numeratorId).toBe("a/width");
    expect(ratio(r2)?.[0]?.denominatorId).toBeUndefined();
    expectParses(f);
  });

  const file = (n: number, path = `f${n}.npy`) => ({
    root: "outputs" as const,
    path,
    sha256: SHA(n),
  });
  const labelsVolume = (n: number): Output => ({
    kind: "volume",
    volume: {
      kind: "labels",
      shapeZyx: [2, 2, 2],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      unit: null,
      file: file(n),
      dtype: "uint8",
    },
  });
  const imageVolume = (n: number): Output => {
    const v = labelsVolume(n);
    if (v.kind !== "volume") throw new Error("not a volume");
    return { kind: "volume", volume: { ...v.volume, kind: "image", dtype: "float32" } };
  };
  const structure = (volume: string, extra: Partial<Extract<Output, { kind: "structure" }>> = {}) =>
    ({ kind: "structure", volume, label: 1, ...extra }) satisfies Output;
  const plan = (...tasks: WorkflowPlan["tasks"]): WorkflowPlan => ({ tasks });

  /** Task seg reports one output of each kind, all declared but the figure. */
  function oneOfEach() {
    const l = log();
    l.run(
      plan({
        id: "seg",
        dependsOn: [],
        outputs: [
          { id: "width", kind: "measurement", required: true, unit: "mm" },
          { id: "grade", kind: "score", required: true, levels: ["0", "1", "2", "3"] },
          { id: "labels", kind: "volume", required: true, volumeKind: "labels" },
          { id: "femur", kind: "structure", required: true, label: 1, name: "Femur" },
          { id: "landmark", kind: "annotation", required: false, shape: "point" },
        ],
      }),
    );
    l.open("w:1:open", W, "seg");
    l.output("w:2", W, "seg", "w:1:open", "labels", labelsVolume(5));
    l.output(
      "w:3",
      W,
      "seg",
      "w:1:open",
      "femur",
      structure("labels", {
        volumeMm3: 7,
        status: "done",
        mesh: { vertices: 3, indices: 3, centerWorldMm: [0, 0, 0], file: file(6, "femur.bin") },
      }),
      { title: "Femur" },
    );
    l.output("w:4", W, "seg", "w:1:open", "landmark", {
      kind: "annotation",
      volume: "labels",
      annotation: { kind: "point", position: [1, 1, 1] },
    });
    l.measurement("w:5", W, "seg", "w:1:open", "width", 3.4, {
      structureIds: ["femur", "gone"],
      annotationIds: ["landmark"],
    });
    l.output("w:6", W, "seg", "w:1:open", "grade", {
      kind: "score",
      level: "2",
      confidence: null,
      structureIds: ["femur"],
      annotationIds: [],
    });
    l.output(
      "w:7",
      W,
      "seg",
      "w:1:open",
      "fig",
      {
        kind: "file",
        file: file(8, "fig.png"),
        mediaType: "image/png",
      },
      { title: "Figure" },
    );
    return l;
  }

  it("one output of each kind goes to its review block", () => {
    const l = oneOfEach();
    const f = fold(l.events);
    const r = rev(f, 0);
    const t = need(f, "seg");
    expect(t.measurements[0]).toMatchObject({
      id: "seg/width",
      value: 3.4,
      unit: "mm",
      structureIds: ["seg/femur"], // "gone" is dropped
      annotationIds: ["seg/landmark"],
      source: { threadId: W, eventId: "w:5" },
    });
    expect(t.scores).toMatchObject([
      { id: "seg/grade", level: "2", scale: ["0", "1", "2", "3"], structureIds: ["seg/femur"] },
    ]);
    expect(r.volumes).toMatchObject([
      { id: "seg/labels", kind: "labels", data: { format: "npy", sha256: SHA(5), dtype: "uint8" } },
    ]);
    expect(r.structures).toMatchObject([
      {
        id: "seg/femur",
        name: "Femur",
        voxels: { volumeId: "seg/labels", label: 1 },
        declared: true,
        status: "done",
        volumeMm3: 7,
        mesh: { sha256: SHA(6), vertices: 3 },
      },
    ]);
    expect(r.annotations).toMatchObject([
      { id: "seg/landmark", kind: "point", volumeId: "seg/labels" },
    ]);
    expect(t.files).toMatchObject([
      { id: "seg/fig", name: "Figure", mediaType: "image/png", sha256: SHA(8) },
    ]);
    expectParses(f);

    l.measurement("w:8", W, "seg", "w:1:open", "width", 3.2, {
      note: "Initial plane",
      evidence: [file(1)],
    });
    l.measurement("w:9", W, "seg", "w:1:open", "width", 3.1, { evidence: [file(2)] });
    l.output("w:10", W, "seg", "w:1:open", "femur", structure("labels", { volumeMm3: 9 }));
    const replaced = fold(l.events);
    const updated = need(replaced, "seg");
    expect(updated.measurements[0]).toMatchObject({
      value: 3.1,
      evidenceIds: [SHA(2)],
      source: { threadId: W, eventId: "w:9" },
    });
    expect(updated.measurements[0]?.note).toBeUndefined();
    expect(updated.evidence.map((e) => e.sha256)).toEqual([SHA(1), SHA(2)]);
    expect(rev(replaced, 0).structures[0]).toMatchObject({ volumeMm3: 9 });
    expect(rev(replaced, 0).structures[0]?.mesh).toBeUndefined();
    expectParses(replaced);
  });

  it("a declared output that is missing is listed until it is reported; an undeclared one is marked", () => {
    const l = log();
    l.run(
      plan({
        id: "a",
        dependsOn: [],
        outputs: [
          { id: "width", kind: "measurement", required: true, unit: "mm" },
          { id: "femur", kind: "structure", required: true },
          { id: "area", kind: "measurement", required: false, unit: "mm^2" },
        ],
      }),
    );
    l.open("w:1:open", W, "a");
    l.measurement("w:2", W, "a", "w:1:open", "extra", 1);
    l.output("w:3", W, "a", "w:1:open", "qc", {
      kind: "score",
      level: "pass",
      confidence: null,
      structureIds: [],
      annotationIds: [],
    });
    let f = fold(l.events);
    // A missing structure is a `Structure`, not a `missing` entry; `missingRequired` has both.
    expect(need(f, "a").missing).toEqual([
      { outputId: "width", kind: "measurement", required: true },
      { outputId: "area", kind: "measurement", required: false },
    ]);
    expect(need(f, "a").missingRequired).toEqual(["width", "femur"]);
    expect(rev(f, 0).structures).toMatchObject([
      { id: "a/femur", declared: true, status: "missing", voxels: null },
    ]);
    expect(need(f, "a").undeclared).toEqual(["a/extra", "a/qc"]);
    expect(need(f, "a").scores[0]?.scale).toBeNull(); // no declaration, no scale
    expectParses(f);
    l.measurement("w:4", W, "a", "w:1:open", "width", 3);
    f = fold(l.events);
    expect(need(f, "a").missing.map((m) => m.outputId)).toEqual(["area"]);
    expect(need(f, "a").missingRequired).toEqual(["femur"]);
    expect(need(f, "a").undeclared).toEqual(["a/extra", "a/qc"]);
    expectParses(f);
  });

  it("a correction replaces a structure without changing the earlier revision", () => {
    const l = oneOfEach();
    l.status("w:8", W, "seg", "w:1:open", "done");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "seg" });
    l.status("sup:1", SUP, "seg", "w:1:open", "stale");
    l.open("w:9:open", W, "seg");
    l.output("w:10", W, "seg", "w:9:open", "labels", labelsVolume(9));
    l.output("w:11", W, "seg", "w:9:open", "femur", structure("labels", { volumeMm3: 9 }), {
      title: "Femur",
    });
    l.measurement("w:12", W, "seg", "w:9:open", "width", 3.1, { structureIds: ["femur"] });
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(r1?.structures).toMatchObject([{ volumeMm3: 7, mesh: { sha256: SHA(6) } }]);
    expect(r2?.structures).toHaveLength(1);
    expect(r2?.structures[0]).toMatchObject({ id: "seg/femur", volumeMm3: 9 });
    expect(r2?.structures[0]?.mesh).toBeUndefined();
    expect(need(r2?.tasks ?? [], "seg").measurements[0]?.structureIds).toEqual(["seg/femur"]);
    expect(need(r1?.tasks ?? [], "seg").measurements[0]?.value).toBe(3.4);
    expect(need(r2?.tasks ?? [], "seg").measurements[0]?.value).toBe(3.1);
    expectParses(f);
  });

  it("a ratio's operand is a declared output of another task; a task redone without it drops it", () => {
    const l = log();
    l.run(
      plan(
        {
          id: "a",
          dependsOn: [],
          outputs: [{ id: "width", kind: "measurement", required: true, unit: "mm" }],
        },
        {
          id: "c",
          dependsOn: ["a"],
          outputs: [{ id: "ratio", kind: "measurement", required: true, unit: "1" }],
        },
      ),
    );
    l.open("w:1:open", W, "a");
    l.measurement("w:2", W, "a", "w:1:open", "width", 3);
    l.status("w:3", W, "a", "w:1:open", "done");
    l.open("w:4:open", W, "c");
    l.measurement("w:5", W, "c", "w:4:open", "ratio", 0.5, { numeratorId: "a/width", unit: "1" });
    l.status("w:6", W, "c", "w:4:open", "done");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1", SUP, "a", "w:1:open", "stale");
    l.open("w:7:open", W, "a");
    const f = fold(l.events);
    const c = (n: number) => need(rev(f, n).tasks, "c");
    expect(c(0)).toMatchObject({ undeclared: [], missing: [] });
    expect(c(0).measurements[0]?.numeratorId).toBe("a/width");
    expect(c(1).measurements[0]?.numeratorId).toBeUndefined();
    expect(need(rev(f, 1).tasks, "a").missing.map((m) => m.outputId)).toEqual(["width"]);
    expectParses(f);
  });

  it("a volume of the wrong volume kind fills no declaration, and a check can't pass while a required output is missing", () => {
    const l = log();
    l.run(
      plan({
        id: "seg",
        dependsOn: [],
        outputs: [
          { id: "labels", kind: "volume", required: true, volumeKind: "labels" },
          { id: "width", kind: "measurement", required: true, unit: "mm" },
        ],
      }),
    );
    l.open("w:1:open", W, "seg");
    l.output("w:2", W, "seg", "w:1:open", "labels", imageVolume(5));
    l.status("w:3", W, "seg", "w:1:open", "done");
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "seg", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "seg", "w:1:open", { verdict: "passed", text: "Looks right." });
    l.result("chk", "seg", "w:1:open");
    const f = fold(l.events);
    expect(need(f, "seg")).toMatchObject({
      undeclared: ["seg/labels"],
      missingRequired: ["labels", "width"],
      status: "to-check",
    });
    expectParses(f);
  });

  /**
   * Task m puts a structure and a landmark on task seg's volume; seg is then
   * redone. Whatever seg reports in the redo, the review has no dangling id.
   */
  function redone(redo: (l: ReturnType<typeof log>) => void) {
    const l = log();
    l.run();
    l.open("s:1:open", W, "seg");
    l.output("s:2", W, "seg", "s:1:open", "labels", labelsVolume(5));
    l.status("s:3", W, "seg", "s:1:open", "done");
    l.open("m:1:open", W, "m");
    l.output("m:2", W, "m", "m:1:open", "femur", structure("seg/labels"));
    l.output("m:3", W, "m", "m:1:open", "a", {
      kind: "annotation",
      volume: "seg/labels",
      annotation: { kind: "point", position: [1, 1, 1] },
    });
    l.output("m:4", W, "m", "m:1:open", "b", {
      kind: "annotation",
      annotation: { kind: "point", position: [0, 0, 0] },
    });
    l.status("m:5", W, "m", "m:1:open", "done");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "seg" });
    l.status("sup:1", SUP, "seg", "s:1:open", "stale");
    l.open("s:6:open", W, "seg");
    redo(l);
    return fold(l.events);
  }

  it("a task redone without the volume others use: their references are dropped, an annotation falls back to the scan", () => {
    const f = redone(() => {});
    const [r1, r2] = f.revisions;
    expect(r1?.structures[0]?.voxels).toMatchObject({ volumeId: "seg/labels" });
    expect(r1?.annotations.map((a) => a.volumeId)).toEqual(["seg/labels", null]);
    expect(r2?.structures[0]?.voxels).toBeNull();
    expect(r2?.annotations.map((a) => a.volumeId)).toEqual([null, null]);
    expectParses(f);
  });

  it("a volume redone as an image: a structure can't use it, an annotation still can", () => {
    const f = redone((l) => l.output("s:7", W, "seg", "s:6:open", "labels", imageVolume(6)));
    const r2 = rev(f, 1);
    expect(r2.volumes).toMatchObject([{ id: "seg/labels", kind: "image" }]);
    expect(r2.structures[0]?.voxels).toBeNull();
    expect(r2.annotations.map((a) => a.volumeId)).toEqual(["seg/labels", null]);
    expectParses(f);
  });
  describe("To check focus", () => {
    const focused = { structureIds: ["seg/femur", "gone"], annotationIds: ["a"] };
    /** Task seg reports a labels volume and a structure; task m, a landmark and a To check item carrying `focus`. */
    function raised(focus: Focus, redo?: (l: ReturnType<typeof log>) => void) {
      const l = log();
      l.run();
      l.open("s:1:open", W, "seg");
      l.output("s:2", W, "seg", "s:1:open", "labels", labelsVolume(5));
      l.output("s:3", W, "seg", "s:1:open", "femur", structure("labels"));
      l.status("s:4", W, "seg", "s:1:open", "done");
      l.open("m:1:open", W, "m");
      l.output("m:2", W, "m", "m:1:open", "a", {
        kind: "annotation",
        annotation: { kind: "point", position: [1, 1, 1] },
      });
      l.checkpoint("m:3", W, "m", "m:1:open", { toCheck: { title: "Femur edge", focus } });
      l.status("m:4", W, "m", "m:1:open", "done");
      if (redo) {
        l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "seg" });
        l.status("sup:1", SUP, "seg", "s:1:open", "stale");
        l.open("s:5:open", W, "seg");
        redo(l);
      }
      return fold(l.events);
    }
    const checks = (f: ReturnType<typeof fold>, n: number) => need(rev(f, n).tasks, "m").checks;

    it("ids resolve across tasks, a same-task id too; one that doesn't is dropped", () => {
      const f = raised(focused);
      expect(checks(f, 0)).toMatchObject([
        { focus: { structureIds: ["seg/femur"], annotationIds: ["m/a"] } },
      ]);
      expectParses(f);
    });

    it("a redo of the other task drops what it no longer reports", () => {
      const f = raised(focused, (l) =>
        l.output("s:6", W, "seg", "s:5:open", "labels", labelsVolume(6)),
      );
      expect(checks(f, 0)[0]?.focus?.structureIds).toEqual(["seg/femur"]);
      expect(checks(f, 1)[0]?.focus).toEqual({ structureIds: [], annotationIds: ["m/a"] });
      expectParses(f);
    });

    it("a region of a labels volume, a box and a point are kept; a focus left empty is absent", () => {
      const region: Focus = {
        structureIds: [],
        annotationIds: [],
        volumeId: "seg/labels",
        label: 2,
        box: { min: [0, 0, 0], max: [1, 1, 1] },
        point: [1, 0, 1],
      };
      const f = raised(region, (l) =>
        l.output("s:6", W, "seg", "s:5:open", "labels", imageVolume(6)),
      );
      expect(checks(f, 0)[0]?.focus).toEqual(region);
      // Redone as an image volume: no longer a labels volume, so the region goes, the box and point stay.
      expect(checks(f, 1)[0]?.focus).toEqual({
        structureIds: [],
        annotationIds: [],
        box: region.box,
        point: region.point,
      });
      expectParses(f);
      const gone = raised({
        structureIds: ["nope"],
        annotationIds: [],
        volumeId: "nope",
        label: 1,
      });
      expect(checks(gone, 0)[0]?.focus).toBeUndefined();
      expectParses(gone);
    });
  });
});

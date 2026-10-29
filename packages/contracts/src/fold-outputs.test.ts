/**
 * Synthetic event sequences for `fold`: outputs routed to review blocks, the
 * plan, and references between outputs, including after another task is redone.
 */
import { describe, expect, it } from "vitest";
import { fold } from "./fold";
import { expectParses, log, need, rev, SHA, SUP, twoDone, W } from "./fold-test-log";
import type { Output } from "./output";
import type { Focus, Volume } from "./review";
import type { DeclaredOutput, WorkflowPlan } from "./workflow";

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
  const ID_AFFINE: Volume["affine"] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  // Voxel (x, y, z) to world: half-mm spacing, offset (10, 20, 30).
  const SCALED: Volume["affine"] = [
    [0.5, 0, 0, 10],
    [0, 0.5, 0, 20],
    [0, 0, 0.5, 30],
    [0, 0, 0, 1],
  ];
  const volume = (
    n: number,
    kind: "labels" | "image",
    gridId: string,
    affine = ID_AFFINE,
  ): Output => ({
    kind: "volume",
    volume: {
      kind,
      gridId,
      shapeZyx: [2, 2, 2],
      affine,
      unit: null,
      file: file(n),
      dtype: kind === "labels" ? "uint8" : "float32",
    },
  });
  const labelsVolume = (n: number) => volume(n, "labels", "labels-grid");
  const imageVolume = (n: number) => volume(n, "image", "image-grid", SCALED);
  const label = (extra: Partial<Extract<Output, { kind: "structure" }>> = {}) =>
    ({ kind: "structure", structure: { label: 1 }, ...extra }) satisfies Output;
  const mask = (n: number): Output => ({
    kind: "structure",
    structure: { mask: file(n), gridId: "image-grid", shapeZyx: [1, 2, 2], offsetZyx: [1, 0, 0] },
  });
  const point = (zyx: [number, number, number]): Output => ({
    kind: "annotation",
    annotation: { gridId: "image-grid", kind: "point", zyx },
  });
  const plan = (...tasks: WorkflowPlan["tasks"]): WorkflowPlan => ({ tasks });
  const decl = {
    labels: { id: "labels", kind: "volume", required: false, volumeKind: "labels" },
    image: { id: "image", kind: "volume", required: false, volumeKind: "image" },
    femur: {
      id: "femur",
      kind: "structure",
      required: false,
      grid: "labels",
      label: 1,
      name: "Femur",
    },
    roi: { id: "roi", kind: "structure", required: false, grid: "image" },
    height: { id: "height", kind: "surface", required: false, grid: "image" },
    landmark: {
      id: "landmark",
      kind: "annotation",
      required: false,
      grid: "image",
      shape: "point",
    },
  } satisfies Record<string, DeclaredOutput>;

  /** Task seg reports one output of each kind, all declared but the figure. */
  function oneOfEach() {
    const l = log();
    l.run(
      plan({
        id: "seg",
        dependsOn: [],
        outputs: [
          decl.labels,
          decl.image,
          decl.femur,
          decl.roi,
          decl.height,
          decl.landmark,
          {
            id: "width",
            kind: "measurement",
            required: true,
            unit: "mm",
            on: ["femur", "landmark", "ghost"],
            context: ["height"],
          },
          {
            id: "grade",
            kind: "score",
            required: true,
            levels: ["0", "1", "2", "3"],
            on: ["femur"],
            context: [],
          },
        ],
      }),
    );
    l.open("w:1:open", W, "seg");
    l.output("w:2", W, "seg", "w:1:open", "labels", labelsVolume(5));
    l.output("w:2b", W, "seg", "w:1:open", "image", imageVolume(4));
    l.output("w:3", W, "seg", "w:1:open", "femur", label({ volumeMm3: 7 }), { title: "Femur" });
    l.output("w:3b", W, "seg", "w:1:open", "roi", mask(9));
    l.output("w:3c", W, "seg", "w:1:open", "height", {
      kind: "surface",
      surface: { gridId: "image-grid", axis: 0, heights: file(10) },
    });
    l.output("w:4", W, "seg", "w:1:open", "landmark", point([2, 4, 6]));
    l.measurement("w:5", W, "seg", "w:1:open", "width", 3.4);
    l.output("w:6", W, "seg", "w:1:open", "grade", {
      kind: "score",
      level: "2",
      confidence: null,
    });
    l.output(
      "w:7",
      W,
      "seg",
      "w:1:open",
      "fig",
      { kind: "file", file: file(8, "fig.png"), mediaType: "image/png" },
      { title: "Figure" },
    );
    return l;
  }

  it("one output of each kind goes to its review block, linked by the plan", () => {
    const l = oneOfEach();
    const f = fold(l.events);
    const r = rev(f, 0);
    const t = need(f, "seg");
    expect(t.measurements[0]).toMatchObject({
      id: "seg/width",
      value: 3.4,
      unit: "mm",
      on: ["seg/femur", "seg/landmark"], // "ghost" names no output
      context: ["seg/height"],
      source: { threadId: W, eventId: "w:5" },
    });
    expect(t.scores).toMatchObject([
      { id: "seg/grade", level: "2", scale: ["0", "1", "2", "3"], on: ["seg/femur"], context: [] },
    ]);
    expect(r.volumes).toMatchObject([
      { id: "seg/labels", kind: "labels", data: { format: "npy", sha256: SHA(5), dtype: "uint8" } },
      { id: "seg/image", kind: "image", gridId: "image-grid" },
    ]);
    expect(r.structures).toMatchObject([
      {
        id: "seg/femur",
        name: "Femur",
        volumeId: "seg/labels",
        voxels: { label: 1 },
        missing: null,
        volumeMm3: 7,
      },
      {
        id: "seg/roi",
        volumeId: "seg/image",
        voxels: {
          mask: { sha256: SHA(9), shapeZyx: [1, 2, 2] },
          offsetZyx: [1, 0, 0],
        },
      },
    ]);
    expect(r.surfaces).toMatchObject([
      { id: "seg/height", volumeId: "seg/image", axis: 0, heights: { sha256: SHA(10) } },
    ]);
    // Voxel [z, y, x] = [2, 4, 6] on the half-mm grid offset (10, 20, 30): world (x, y, z) mm.
    expect(r.annotations).toMatchObject([
      { id: "seg/landmark", kind: "point", volumeId: "seg/image", position: [13, 22, 31] },
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
    l.output("w:10", W, "seg", "w:1:open", "femur", label({ volumeMm3: 9 }));
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
    expectParses(replaced);
  });

  it("a line annotation maps both endpoints through the grid's affine", () => {
    const l = log();
    l.run(
      plan({
        id: "t",
        dependsOn: [],
        outputs: [
          decl.image,
          { id: "ruler", kind: "annotation", required: false, grid: "image", shape: "line" },
        ],
      }),
    );
    l.open("w:1:open", W, "t");
    l.output("w:2", W, "t", "w:1:open", "image", imageVolume(4));
    l.output("w:3", W, "t", "w:1:open", "ruler", {
      kind: "annotation",
      annotation: { gridId: "image-grid", kind: "line", aZyx: [0, 0, 0], bZyx: [2, 4, 6.5] },
    });
    const f = fold(l.events);
    expect(rev(f, 0).annotations).toMatchObject([
      { kind: "line", a: [10, 20, 30], b: [13.25, 22, 31] },
    ]);
    expectParses(f);
  });

  it("assets come from the whole log, the latest event per source file", () => {
    const l = oneOfEach();
    const levels = [
      {
        path: "0",
        shapeZyx: [2, 2, 2] as [number, number, number],
        scaleZyx: [1, 1, 1] as [number, number, number],
      },
    ];
    l.add("assets.failed", "a:1", "root", { sourceSha256: SHA(5), error: "boom" });
    l.add("assets.ready", "a:2", "root", { sourceSha256: SHA(4), levels, meshes: [] });
    const f = fold(l.events);
    expect(f.assets).toEqual({
      [SHA(5)]: { state: "failed", error: "boom" },
      [SHA(4)]: { state: "ready", levels, meshes: [] },
    });
    expectParses(f);
  });

  it("a declared output that is missing is listed until it is reported; an undeclared one is marked", () => {
    const l = log();
    l.run(
      plan({
        id: "a",
        dependsOn: [],
        outputs: [
          decl.labels,
          { ...decl.femur, required: false },
          {
            id: "width",
            kind: "measurement",
            required: true,
            unit: "mm",
            on: ["femur"],
            context: [],
          },
          {
            id: "area",
            kind: "measurement",
            required: false,
            unit: "mm^2",
            on: ["femur"],
            context: [],
          },
        ],
      }),
    );
    l.open("w:1:open", W, "a");
    l.measurement("w:2", W, "a", "w:1:open", "extra", 1);
    l.output("w:3", W, "a", "w:1:open", "qc", { kind: "score", level: "pass", confidence: null });
    let f = fold(l.events);
    expect(need(f, "a").missing).toEqual([
      { outputId: "labels", kind: "volume", required: false },
      { outputId: "femur", kind: "structure", required: false },
      { outputId: "width", kind: "measurement", required: true },
      { outputId: "area", kind: "measurement", required: false },
    ]);
    expect(need(f, "a").missingRequired).toEqual(["width"]);
    expect(rev(f, 0).structures).toEqual([]);
    expect(need(f, "a").undeclared).toEqual(["a/extra", "a/qc"]);
    expect(need(f, "a").scores[0]?.scale).toBeNull(); // no declaration, no scale
    expectParses(f);
    l.measurement("w:4", W, "a", "w:1:open", "width", 3);
    f = fold(l.events);
    expect(need(f, "a").missingRequired).toEqual([]);
    expect(need(f, "a").measurements.find((m) => m.id === "a/width")?.on).toEqual([]); // no block to show it on

    // Reported as missing counts as reported: a block with the reason, no voxels.
    l.output("w:5", W, "a", "w:1:open", "femur", { kind: "missing", reason: "out of the field" });
    f = fold(l.events);
    expect(rev(f, 0).structures).toMatchObject([
      {
        id: "a/femur",
        missing: { reason: "out of the field" },
        voxels: null,
      },
    ]);
    expect(need(f, "a").measurements.find((m) => m.id === "a/width")?.on).toEqual(["a/femur"]);
    expectParses(f);
  });

  it("a correction replaces a structure without changing the earlier revision", () => {
    const l = oneOfEach();
    l.status("w:8", W, "seg", "w:1:open", "done");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "seg" });
    l.status("sup:1", SUP, "seg", "w:1:open", "stale");
    l.open("w:9:open", W, "seg");
    l.output("w:10", W, "seg", "w:9:open", "labels", labelsVolume(9));
    l.output("w:11", W, "seg", "w:9:open", "femur", label({ volumeMm3: 9 }), { title: "Femur" });
    l.measurement("w:12", W, "seg", "w:9:open", "width", 3.1);
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(r1?.structures.map((s) => [s.id, s.volumeMm3])).toEqual([
      ["seg/femur", 7],
      ["seg/roi", undefined],
    ]);
    expect(r2?.structures[0]).toMatchObject({ id: "seg/femur", volumeMm3: 9 });
    // The redo has not reported the image grid: what sits on it is gone, and so is the link.
    expect(r2?.surfaces).toEqual([]);
    expect(r2?.annotations).toEqual([]);
    expect(need(r1?.tasks ?? [], "seg").measurements[0]?.on).toEqual(["seg/femur", "seg/landmark"]);
    expect(need(r2?.tasks ?? [], "seg").measurements[0]?.on).toEqual(["seg/femur"]);
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
          outputs: [
            {
              id: "width",
              kind: "measurement",
              required: true,
              unit: "mm",
              on: ["g"],
              context: [],
            },
            { id: "g", kind: "volume", required: false, volumeKind: "image" },
          ],
        },
        {
          id: "c",
          dependsOn: ["a"],
          outputs: [
            { id: "ratio", kind: "measurement", required: true, unit: "1", on: ["g"], context: [] },
          ],
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
    expect(need(rev(f, 1).tasks, "a").missing.map((m) => m.outputId)).toEqual(["width", "g"]);
    expectParses(f);
  });

  it("a volume of the wrong volume kind fills no declaration, and a check can't pass while a required output is missing", () => {
    const l = log();
    l.run(
      plan({
        id: "seg",
        dependsOn: [],
        outputs: [
          { ...decl.labels, required: true },
          {
            id: "width",
            kind: "measurement",
            required: true,
            unit: "mm",
            on: ["labels"],
            context: [],
          },
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
   * Task m puts a structure (a mask), a surface and a landmark on task seg's
   * image grid; seg is then redone. Whatever seg reports in the redo, the
   * review has no dangling id.
   */
  const gridPlan = plan(
    { id: "seg", dependsOn: [], outputs: [decl.image] },
    {
      id: "m",
      dependsOn: ["seg"],
      outputs: [
        { ...decl.roi, id: "roi" },
        decl.height,
        decl.landmark,
        {
          id: "size",
          kind: "measurement",
          required: true,
          unit: "mm",
          on: ["roi", "landmark"],
          context: ["height"],
        },
      ],
    },
  );
  function redone(redo: (l: ReturnType<typeof log>) => void) {
    const l = log();
    l.run(gridPlan);
    l.open("s:1:open", W, "seg");
    l.output("s:2", W, "seg", "s:1:open", "image", imageVolume(5));
    l.status("s:3", W, "seg", "s:1:open", "done");
    l.open("m:1:open", W, "m");
    l.output("m:2", W, "m", "m:1:open", "roi", mask(6));
    l.output("m:3", W, "m", "m:1:open", "landmark", point([1, 1, 1]));
    l.output("m:4", W, "m", "m:1:open", "height", {
      kind: "surface",
      surface: { gridId: "image-grid", axis: 1, heights: file(7) },
    });
    l.measurement("m:5", W, "m", "m:1:open", "size", 1);
    l.status("m:6", W, "m", "m:1:open", "done");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "seg" });
    l.status("sup:1", SUP, "seg", "s:1:open", "stale");
    l.open("s:6:open", W, "seg");
    redo(l);
    return fold(l.events);
  }
  const sizeOn = (f: ReturnType<typeof fold>, n: number) =>
    need(rev(f, n).tasks, "m").measurements[0];

  it("a task redone without the grid others sit on: the surface and landmark go, the structure loses its voxels, links follow", () => {
    const f = redone(() => {});
    const [r1, r2] = f.revisions;
    expect(r1?.structures[0]).toMatchObject({ volumeId: "seg/image", voxels: { mask: {} } });
    expect(r1?.surfaces.map((s) => s.volumeId)).toEqual(["seg/image"]);
    expect(r1?.annotations.map((a) => a.volumeId)).toEqual(["seg/image"]);
    expect(sizeOn(f, 0)).toMatchObject({ on: ["m/roi", "m/landmark"], context: ["m/height"] });
    expect(r2?.structures[0]).toMatchObject({ id: "m/roi", volumeId: null, voxels: null });
    expect(r2?.surfaces).toEqual([]);
    expect(r2?.annotations).toEqual([]);
    expect(sizeOn(f, 1)).toMatchObject({ on: ["m/roi"], context: [] });
    expectParses(f);
  });

  it("the grid redone: what sits on it moves to the new grid", () => {
    const f = redone((l) => l.output("s:7", W, "seg", "s:6:open", "image", imageVolume(8)));
    const r2 = rev(f, 1);
    expect(r2.volumes).toMatchObject([
      { id: "seg/image", kind: "image", data: { sha256: SHA(8) } },
    ]);
    expect(r2.structures[0]?.volumeId).toBe("seg/image");
    expect(r2.annotations).toHaveLength(1);
    expectParses(f);
  });

  describe("To check focus", () => {
    const focused = { on: ["m/roi", "gone", "landmark", "seg/labels"] };
    /** Task seg reports the grid; task m, a structure, a landmark and a To check item carrying `focus`. */
    function raised(focus: Focus, redo?: (l: ReturnType<typeof log>) => void) {
      const l = log();
      l.run(
        plan(
          { id: "seg", dependsOn: [], outputs: [decl.image, decl.labels] },
          { id: "m", dependsOn: ["seg"], outputs: [decl.roi, decl.landmark] },
        ),
      );
      l.open("s:1:open", W, "seg");
      l.output("s:2", W, "seg", "s:1:open", "image", imageVolume(5));
      l.output("s:3", W, "seg", "s:1:open", "labels", labelsVolume(4));
      l.status("s:4", W, "seg", "s:1:open", "done");
      l.open("m:1:open", W, "m");
      l.output("m:2", W, "m", "m:1:open", "roi", mask(3));
      l.output("m:2b", W, "m", "m:1:open", "landmark", point([1, 1, 1]));
      l.checkpoint("m:3", W, "m", "m:1:open", { toCheck: { title: "Edge", focus } });
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
        { focus: { on: ["m/roi", "m/landmark", "seg/labels"] } },
      ]);
      expectParses(f);
    });

    it("a redo of the grid drops the blocks on it and the focus ids that named them", () => {
      const f = raised(focused, (l) =>
        l.output("s:6", W, "seg", "s:5:open", "labels", labelsVolume(6)),
      );
      expect(checks(f, 0)[0]?.focus?.on).toEqual(["m/roi", "m/landmark", "seg/labels"]);
      // The structure stays (its voxels are null); the landmark sat on the grid and is gone.
      expect(checks(f, 1)[0]?.focus).toEqual({ on: ["m/roi", "seg/labels"] });
      expectParses(f);
    });

    it("a region of a labels volume, a box and a point are kept; a focus left empty is absent", () => {
      const region: Focus = {
        on: [],
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
        on: [],
        box: region.box,
        point: region.point,
      });
      expectParses(f);
      const gone = raised({
        on: ["nope"],
        volumeId: "nope",
        label: 1,
      });
      expect(checks(gone, 0)[0]?.focus).toBeUndefined();
      expectParses(gone);
    });
  });
});

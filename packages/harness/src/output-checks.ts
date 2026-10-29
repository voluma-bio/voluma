/**
 * The write-time checks of `report_output` (`@voluma/contracts/task-tools`): the call
 * against the plan's declaration for the output, what it is placed on against what the
 * run has already reported, and a ruler against its measurement. Each returns the refusal
 * text, or nothing.
 */
import type { Folded } from "@voluma/contracts/fold";
import { rulerLengthProblem } from "@voluma/contracts/ruler";
import type { ReportOutputInput } from "@voluma/contracts/task-tools";
import type { DeclaredOutput, WorkflowPlan } from "@voluma/contracts/workflow";

type Out = ReportOutputInput["output"];

const OBJECTS = new Set(["structure", "surface", "annotation", "volume"]);

/** `title` is the report's; a declared structure names its `title` by `name`. */
export function declarationProblem(
  declared: DeclaredOutput | undefined,
  { title, output }: Pick<ReportOutputInput, "title" | "output">,
): string | undefined {
  if (!declared) {
    // Review places an object by its declaration's grid; a value or file needs no place.
    return OBJECTS.has(output.kind)
      ? `This ${output.kind} is not in the plan. Only declared objects (structures, surfaces, annotations, volumes) can be reported: review cannot place others.`
      : undefined;
  }
  const quote = `The plan declares: ${JSON.stringify(declared)}.`;
  const mismatch = (what: string) => `${what}. ${quote}`;
  if (declared.kind !== output.kind) return mismatch(`This output is a ${output.kind}`);
  switch (declared.kind) {
    case "measurement":
      if (output.kind === "measurement" && output.unit !== declared.unit)
        return mismatch(`The unit is ${output.unit}`);
      break;
    case "score":
      if (output.kind === "score" && !declared.levels.includes(output.level))
        return mismatch(`The level ${output.level} is not on the scale`);
      break;
    case "structure": {
      if (output.kind !== "structure") break;
      const s = output.structure;
      if ("label" in s && s.label !== declared.label) return mismatch(`The label is ${s.label}`);
      if ("mask" in s && declared.label !== undefined)
        return mismatch("The structure has a label in its grid; report that label, not a mask");
      if (declared.name !== undefined && title !== declared.name)
        return mismatch(`The title is "${title}"`);
      break;
    }
    case "surface":
      break;
    case "annotation":
      if (output.kind === "annotation" && output.annotation.kind !== declared.shape)
        return mismatch(`The annotation is a ${output.annotation.kind}`);
      break;
    case "volume":
      if (output.kind === "volume" && output.volume.kind !== declared.volumeKind)
        return mismatch(`The volume is of kind ${output.volume.kind}`);
      break;
    case "file":
      if (output.kind === "file" && output.mediaType !== declared.mediaType)
        return mismatch(`The media type is ${output.mediaType}`);
      break;
  }
  return undefined;
}

const FITS = {
  labels: ["uint8", "uint16"],
  image: ["int16", "uint16", "float32"],
} as const;

/** A ratio's operands must be measurements the task's latest attempt reported; a volume's dtype must fit its kind. */
export function referenceProblem(view: Folded, taskId: string, output: Out): string | undefined {
  if (output.kind === "volume") {
    const { kind, dtype } = output.volume;
    if (!(FITS[kind] as readonly string[]).includes(dtype))
      return `A ${kind} volume is ${FITS[kind].join(", ")}; this one is ${dtype}.`;
    return undefined;
  }
  if (output.kind !== "measurement") return undefined;
  const reported = new Set(view.tasks.flatMap((t) => t.measurements.map((m) => m.id)));
  const missing = [output.numeratorId, output.denominatorId].filter(
    (id): id is string =>
      id !== undefined && !reported.has(id.includes("/") ? id : `${taskId}/${id}`),
  );
  return missing.length === 0
    ? undefined
    : `These references are not reported yet in the named task's latest attempt: ${missing.join(", ")} (measurement). Report their targets first.`;
}

/**
 * Where an object sits and whether a ruler agrees with its number. A structure, surface or
 * annotation needs its declared grid reported before it (a missing structure has no voxels);
 * a line annotation and the length measurement that names it are checked against each other
 * when the second of the pair arrives (`rulerLengthProblem`).
 */
export function placementProblem(
  view: Folded,
  plan: WorkflowPlan["tasks"],
  { outputId, output }: { outputId: string; output: Out },
): string | undefined {
  const declared = new Map(
    plan.flatMap((t) => t.outputs.map((d) => [d.id, { task: t.id, ...d }] as const)),
  );
  const self = declared.get(outputId);
  const last = view.revisions.at(-1);
  const volumes = new Map((last?.volumes ?? []).map((v) => [v.id, v]));
  const isLine = (id: string) => {
    const d = declared.get(id);
    return d?.kind === "annotation" && d.shape === "line";
  };
  // The one length measurement-and-ruler pair a measurement of mm stands for: exactly one line in its `on`.
  const rulerOf = (m: DeclaredOutput) =>
    m.kind === "measurement" && m.unit === "mm" ? m.on.filter(isLine) : [];

  if (output.kind === "measurement") {
    const lines = self ? rulerOf(self) : [];
    const [lineId] = lines;
    const line =
      lineId && last?.annotations.find((a) => a.id === `${declared.get(lineId)?.task}/${lineId}`);
    if (lines.length !== 1 || !line || line.kind !== "line" || output.value === null)
      return undefined;
    // The block holds world mm already, so measure it through the identity.
    const zyx = (p: readonly number[]): [number, number, number] => [
      p[2] ?? 0,
      p[1] ?? 0,
      p[0] ?? 0,
    ];
    const problem = rulerLengthProblem(
      { aZyx: zyx(line.a), bZyx: zyx(line.b) },
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      { value: output.value, unit: output.unit },
    );
    return problem && `Ruler "${lineId}": ${problem}.`;
  }

  if (!self || !("grid" in self)) return undefined;
  if (output.kind === "structure" && "status" in output.structure) return undefined;
  const gridTask = declared.get(self.grid)?.task;
  const grid = volumes.get(`${gridTask}/${self.grid}`);
  if (!grid)
    return `Its grid "${self.grid}" (task "${gridTask}") is not reported yet in that task's latest attempt. Report the grid first.`;

  const reportedGrid =
    output.kind === "annotation"
      ? output.gridId
      : output.kind === "surface"
        ? output.surface.gridId
        : output.kind === "structure" && "mask" in output.structure
          ? output.structure.gridId
          : undefined;
  if (reportedGrid !== undefined && reportedGrid !== grid.gridId)
    return `This was made on grid "${reportedGrid}", but "${self.grid}" was reported as grid "${grid.gridId}". Redo it on that grid.`;

  if (output.kind !== "annotation" || output.annotation.kind !== "line") return undefined;
  const line = { aZyx: output.annotation.aZyx, bZyx: output.annotation.bZyx };
  for (const m of plan.flatMap((t) => t.outputs.map((d) => [t.id, d] as const))) {
    const [mTask, d] = m;
    if (d.kind !== "measurement" || rulerOf(d).length !== 1 || !d.on.includes(outputId)) continue;
    const measured = view.tasks
      .find((t) => t.id === mTask)
      ?.measurements.find((x) => x.id === `${mTask}/${d.id}`);
    if (measured?.value == null) continue;
    const problem = rulerLengthProblem(line, grid.affine, {
      value: measured.value,
      unit: measured.unit,
    });
    if (problem) return `Measurement "${d.id}": ${problem}.`;
  }
  return undefined;
}

/**
 * The write-time checks of `report_output` (`@voluma/contracts/task-tools`): the call
 * against the plan's declaration for the output, and its references against what the
 * task's latest attempt has already reported. Each returns the refusal text, or nothing.
 */
import type { Folded } from "@voluma/contracts/fold";
import type { ReportOutputInput } from "@voluma/contracts/task-tools";
import type { DeclaredOutput } from "@voluma/contracts/workflow";

type Out = ReportOutputInput["output"];

/** `title` is the report's; a declared structure names its `title` by `name`. */
export function declarationProblem(
  declared: DeclaredOutput | undefined,
  { title, output }: Pick<ReportOutputInput, "title" | "output">,
): string | undefined {
  if (!declared) return undefined; // Undeclared outputs are accepted; the fold lists them.
  const quote = `The plan declares: ${JSON.stringify(declared)}.`;
  const mismatch = (what: string) => `${what}. ${quote}`;
  if (output.kind === "missing") {
    // A measurement says it is missing with `value: null` and a reason, so it has one shape.
    return declared.kind === "measurement"
      ? mismatch("A measurement declaration takes `value: null` with a reason, not `missing`")
      : undefined;
  }
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
    case "structure":
      if (output.kind !== "structure") break;
      if (declared.label !== undefined && output.label !== declared.label)
        return mismatch(`The label is ${output.label ?? "unset"}`);
      if (declared.name !== undefined && title !== declared.name)
        return mismatch(`The title is "${title}"`);
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

type Kind = "measurement" | "structure" | "annotation" | "volume:image" | "volume:labels";

const FITS = {
  labels: ["uint8", "uint16"],
  image: ["int16", "uint16", "float32"],
} as const;

/**
 * What a call may point at: `taskId/outputId` → block kind, for the outputs the latest
 * revision holds (that is the latest attempt of each task). A score is never a target.
 */
function reported(view: Folded): Map<string, Kind> {
  const last = view.revisions.at(-1);
  const kinds = new Map<string, Kind>();
  for (const t of view.tasks) for (const m of t.measurements) kinds.set(m.id, "measurement");
  for (const s of last?.structures ?? []) kinds.set(s.id, "structure");
  for (const a of last?.annotations ?? []) kinds.set(a.id, "annotation");
  for (const v of last?.volumes ?? []) kinds.set(v.id, `volume:${v.kind}`);
  return kinds;
}

export function referenceProblem(view: Folded, taskId: string, output: Out): string | undefined {
  const kinds = reported(view);
  const missing: string[] = [];
  const need = (id: string | undefined, ...accept: Kind[]) => {
    if (id === undefined) return;
    const full = id.includes("/") ? id : `${taskId}/${id}`;
    const kind = kinds.get(full);
    if (!kind || !accept.includes(kind)) missing.push(`${id} (${accept.join(" or ")})`);
  };
  if (output.kind === "measurement") {
    need(output.numeratorId, "measurement");
    need(output.denominatorId, "measurement");
  }
  if (output.kind === "measurement" || output.kind === "score") {
    for (const id of output.structureIds) need(id, "structure");
    for (const id of output.annotationIds) need(id, "annotation");
  }
  switch (output.kind) {
    case "structure":
      need(output.volume, "volume:labels");
      break;
    case "annotation":
      need(output.volume, "volume:image", "volume:labels");
      break;
    case "volume": {
      const { kind, dtype } = output.volume;
      if (!(FITS[kind] as readonly string[]).includes(dtype))
        return `A ${kind} volume is ${FITS[kind].join(", ")}; this one is ${dtype}.`;
      break;
    }
    case "file":
    case "missing":
      break;
  }
  return missing.length === 0
    ? undefined
    : `These references are not reported yet in the named task's latest attempt: ${missing.join(", ")}. Report their targets first.`;
}

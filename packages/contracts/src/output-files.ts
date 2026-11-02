/**
 * The two files agents read in `/run/`, rendered from the events (`output-fold.ts`); nobody edits
 * them. Pure: the harness writes the text where `/run/` is mounted (`runFilesPrefix`).
 *
 * - `/run/final-outputs.yaml`: the run's final outputs in sections (`finalOutputsSchema`), its missing ones and its changes.
 * - `/run/outputs.yaml`: every published output, final and intermediate, with its status, its
 *   latest version (files as `/outputs/...` paths an agent opens directly, `madeFrom`, open To
 *   check items) and the earlier versions. There is no "latest" alias on the read-only mount, so
 *   a version is always named by its folder.
 */
import { stringify } from "yaml";
import type { RunEvent } from "./events";
import type { FinalOutputs } from "./final-outputs";
import { OUTPUTS_MOUNT, type OutputVersion, outputsFold } from "./output-fold";

const folder = (v: Pick<OutputVersion, "path">) => `${OUTPUTS_MOUNT}/${v.path}/`;

const versionBlock = (v: OutputVersion, detailed: boolean) => ({
  version: v.version,
  by: v.by,
  at: v.at,
  path: folder(v),
  ...(detailed && {
    ...(v.value && { value: v.value.number, unit: v.value.unit }),
    ...(v.files.length > 0 && { files: v.files.map((f) => `${folder(v)}${f.name}`) }),
    madeFrom: v.madeFrom,
    ...(v.provisional && { provisional: true }),
    ...(v.kept && { kept: v.kept.reason }),
    ...(v.toCheck.some((t) => !t.resolved) && {
      toCheck: v.toCheck.filter((t) => !t.resolved).map((t) => t.title),
    }),
  }),
});

/** `/run/final-outputs.yaml`; empty before the run's first `outputs.changed`. */
export function renderFinalOutputs(events: readonly RunEvent[]): string {
  const { list } = outputsFold(events);
  return stringify(list ?? ({ sections: [], changes: [] } satisfies FinalOutputs));
}

/** `/run/outputs.yaml`. */
export function renderOutputsIndex(events: readonly RunEvent[]): string {
  const published = outputsFold(events).outputs.filter((o) => o.latest);
  return stringify({
    outputs: published.map((o) => ({
      id: o.id,
      ...(o.kind && { kind: o.kind }),
      ...(o.base && { base: o.base }),
      final: o.final,
      ...(!o.declared && { declared: false }),
      status: o.status,
      ...(o.latest && { latest: versionBlock(o.latest, true) }),
      ...(o.versions.length > 1 && {
        earlier: o.versions.slice(0, -1).map((v) => versionBlock(v, false)),
      }),
    })),
  });
}

/**
 * One stored task-loop run's log in, the agent-loop events that replace its outputs out. Pure:
 * `convert-task-runs.ts` fetches the logs, checks the files in R2 and turns the result into the
 * migration. The mapping and its reasons are in `apps/api/.context/convert-task-runs.md`.
 *
 * The run's final outputs are what the task fold shows in its last revision (`reviewState`): the
 * latest `output` of each task's current attempt. Each becomes one `output.published`, version 1,
 * whose folder is the task's own (`outputs/<task>/`), so no object moves. Everything the agent
 * review would show that cannot be made is listed, never silently left out.
 */

import type { RunEvent } from "@voluma/contracts/events";
import {
  openingChange,
  openingOutputs,
  refuseOutputsChange,
} from "@voluma/contracts/final-outputs";
import { abandonedEvents } from "@voluma/contracts/fold";
import type { Output } from "@voluma/contracts/output";
import {
  convertedAs,
  labelMapOf,
  type OutputCatalog,
  type OutputEntry,
} from "@voluma/contracts/output-catalog";
import { outputsPrefix } from "@voluma/contracts/r2";
import type { Focus } from "@voluma/contracts/review";
import { reviewState } from "@voluma/contracts/review-state";

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;
type Ref = { name: string; sha256: string };

/** An event to insert; `seq` is the database's (the next after the run's last). */
export interface NewEvent {
  id: string;
  threadId: string;
  createdAt: string;
  type: "outputs.changed" | "output.published" | "tocheck.resolved";
  payload: unknown;
}

export interface RunReport {
  runId: string;
  /** The opening final outputs. */
  selected: string[];
  published: string[];
  missing: { id: string; reason: string }[];
  /** Outputs the task loop reported that no version could be made of. */
  dropped: { id: string; why: string }[];
  /** To check items that did not carry over. */
  droppedChecks: { task: string; title: string; why: string }[];
  /** Files named by a version that R2 lacks or holds with other bytes (exact keys). */
  r2Misses: string[];
}

/** Why the object at `key` is not the file reported as `sha256`, or undefined when it is. */
export type FileCheck = (key: string, sha256: string) => string | undefined;

const MISSING_REASON = "The run ended without reporting it.";

/** UCUM as `outputs.yaml` writes it, from the notation a task used (superscripts, micro sign, HU). */
const ucum = (unit: string) =>
  unit.replaceAll("³", "3").replaceAll("²", "2").replaceAll("µ", "u").replace(/^HU$/, "[hnsf'U]");

export function convertRun(o: {
  runId: string;
  events: readonly RunEvent[];
  selectedOutputs: readonly string[] | undefined;
  catalog: OutputCatalog;
  check: FileCheck;
}): { events: NewEvent[]; report: RunReport } {
  const { runId, events, catalog } = o;
  const report: RunReport = {
    runId,
    selected: [],
    published: [],
    missing: [],
    dropped: [],
    droppedChecks: [],
    r2Misses: [],
  };
  const state = reviewState(events);
  const last = state.revisions.at(-1);
  const root = events.find((e) => e.type === "thread.started" && e.payload.parentThreadId === null);
  const opening = events.find((e) => e.type === "revision.started");
  if (!last || !root || !opening) return { events: [], report };

  const out: NewEvent[] = [];
  const entryOf = (id: string): OutputEntry | undefined => catalog.find((e) => e.id === id);
  const idOf = (name: string) => `convert:${runId}:${name}`;

  // The opening list, grouped by the plan's tasks.
  const change = openingChange(catalog, o.selectedOutputs);
  const listed = new Set(openingOutputs(catalog, o.selectedOutputs).map((e) => e.id));
  report.selected = [...listed];
  if (change) {
    const sections = last.plan.tasks.flatMap((t) => {
      const ids = t.outputs.map((x) => x.id).filter((id) => listed.has(id));
      return ids.length > 0 ? [{ title: t.title ?? t.id, outputs: ids }] : [];
    });
    const why = refuseOutputsChange(undefined, { ...change, sections }, catalog);
    if (why) throw new Error(`${runId}: the opening outputs were refused: ${why}`);
    out.push({
      id: idOf("outputs"),
      threadId: root.threadId,
      createdAt: opening.createdAt,
      type: "outputs.changed",
      payload: { ...change, sections },
    });
  }

  // Each task's current attempt's latest output per id, as the task fold keeps them.
  const abandoned = abandonedEvents(events, undefined, true);
  const attempts = new Map<string, Map<string, Ev<"output">>>();
  const current = new Map<string, Map<string, Ev<"output">>>();
  for (const e of events) {
    if (abandoned.has(e.id)) continue;
    if (e.type === "attempt.opened") {
      const outputs = new Map<string, Ev<"output">>();
      attempts.set(e.id, outputs);
      current.set(e.payload.taskId, outputs);
    } else if (e.type === "output") attempts.get(e.payload.attemptId)?.set(e.payload.outputId, e);
  }
  const reportedMissing = new Map<string, string>();
  const finals = new Map<string, { task: string; event: Ev<"output"> }>();
  for (const [task, outputs] of current)
    for (const [id, event] of outputs) {
      const reported = event.payload.output;
      if (reported.kind === "missing") reportedMissing.set(id, reported.reason);
      else if (reported.kind === "measurement" && reported.value === null)
        reportedMissing.set(id, "No value was reported.");
      else if (finals.has(id))
        report.dropped.push({
          id: `${task}/${id}`,
          why: `${finals.get(id)?.task} also reported ${id}`,
        });
      else finals.set(id, { task, event });
    }

  // One version per output the catalog can hold.
  const versions = new Map<
    string,
    { task: string; event: Ev<"output">; payload: Record<string, unknown> }
  >();
  const keyOf = (task: string, name: string) => `${outputsPrefix(runId)}${task}/${name}`;
  const fileOk = (task: string, ref: Ref): boolean => {
    const why = o.check(keyOf(task, ref.name), ref.sha256);
    if (why) report.r2Misses.push(`${keyOf(task, ref.name)} (${why})`);
    return why === undefined;
  };
  for (const [id, { task, event }] of finals) {
    const entry = entryOf(id);
    const p = event.payload;
    const out_ = p.output;
    const drop = (why: string) => report.dropped.push({ id: `${task}/${id}`, why });
    if (!entry) {
      drop("not an output of the workflow's catalog");
      continue;
    }
    // A label structure has no version of its own: its map's covers it (checked below).
    if (out_.kind === "structure" && "label" in out_.structure) continue;
    const built = versionOf(entry, out_, event);
    if (typeof built === "string") {
      drop(built);
      continue;
    }
    const files = built.files?.filter((f) => f.root === "outputs") ?? [];
    if (built.files && files.length === 0) {
      drop("its file is not under the task's outputs");
      continue;
    }
    const named = files.map((f) => ({ name: f.path, sha256: f.sha256 }));
    if (!named.every((f) => fileOk(task, f))) {
      drop("its file is missing from R2");
      continue;
    }
    const own = new Set(named.map((f) => f.name));
    const evidence = p.evidence
      .filter((r) => r.root === "outputs" && !own.has(r.path))
      .map((r) => ({ name: r.path, sha256: r.sha256 }))
      .filter((r, i, all) => all.findIndex((x) => x.name === r.name) === i)
      .filter((r) => fileOk(task, r));
    const annotation = last.annotations.find((a) => a.id === `${task}/${id}`);
    const points =
      annotation &&
      (annotation.kind === "line" ? [annotation.a, annotation.b] : [annotation.position]);
    versions.set(id, {
      task,
      event,
      payload: {
        outputId: id,
        version: 1,
        path: task,
        ...(named.length > 0 && { files: named }),
        ...(built.value && { value: built.value }),
        kind: entry.kind,
        ...(entry.kind === "overlay" && { base: entry.base }),
        madeFrom: [],
        ...(evidence.length > 0 && { evidence }),
        ...(built.detail || points
          ? {
              detail: {
                ...(convertedAs(entry) && { as: convertedAs(entry) }),
                ...built.detail,
                ...(points && { points }),
              },
            }
          : convertedAs(entry) && { detail: { as: convertedAs(entry) } }),
      },
    });
  }
  // A label structure has no version of its own: its map's covers it.
  for (const [id, { task, event }] of finals) {
    const entry = entryOf(id);
    if (event.payload.output.kind !== "structure" || !("label" in event.payload.output.structure))
      continue;
    if (entry?.kind !== "overlay" || !entry.label) {
      report.dropped.push({ id: `${task}/${id}`, why: "a label the catalog does not list" });
    } else if (!versions.has(entry.label.of))
      report.dropped.push({ id: `${task}/${id}`, why: `its map ${entry.label.of} has no version` });
  }
  const covers = (id: string) => versions.has(labelMapOf(catalog, id));

  // Links, now that every version is known.
  for (const [id, v] of versions) {
    const entry = entryOf(id) as OutputEntry;
    const links: { id: string; role: "on" | "context" | "base" }[] =
      entry.kind === "value"
        ? [
            ...entry.on.map((x) => ({ id: x, role: "on" as const })),
            ...(entry.context ?? []).map((x) => ({ id: x, role: "context" as const })),
          ]
        : entry.kind === "overlay"
          ? [{ id: entry.base, role: "base" as const }]
          : [];
    v.payload.madeFrom = links.filter((l) => covers(l.id)).map((l) => ({ ...l, version: 1 }));
  }

  // To check items go on the version of the output they point at.
  const items = new Map<string, { title: string; focus?: Focus }[]>();
  const resolved = new Map<string, { by: string; at: string; thread: string }>();
  const accepted = new Map<string, Ev<"check.accepted">>();
  for (const e of events)
    if (e.type === "check.accepted")
      accepted.set(
        JSON.stringify([e.payload.taskId, e.payload.resultRevisionId, e.payload.checkId]),
        e,
      );
  const bare = (id: string) => id.slice(id.indexOf("/") + 1);
  for (const task of last.tasks)
    for (const c of task.checks) {
      const focus = c.focus;
      const targets = [...(focus?.on ?? []), ...(focus?.volumeId ? [focus.volumeId] : [])].map(
        bare,
      );
      const target = targets.find(covers);
      if (target === undefined) {
        report.droppedChecks.push({
          task: task.id,
          title: c.title,
          why: targets.length === 0 ? "it points at no output" : "its output has no version",
        });
        continue;
      }
      const owner = labelMapOf(catalog, target);
      const volumeId =
        focus?.volumeId && entryOf(bare(focus.volumeId)) ? bare(focus.volumeId) : undefined;
      const on = (focus?.on ?? []).map(bare).filter((x) => entryOf(x));
      const moved: Focus | undefined =
        focus && (on.length > 0 || volumeId || focus.box || focus.point)
          ? {
              on,
              ...(volumeId && {
                volumeId,
                ...(focus.label !== undefined && { label: focus.label }),
              }),
              ...(focus.box && { box: focus.box }),
              ...(focus.point && { point: focus.point }),
            }
          : undefined;
      const held = items.get(owner) ?? [];
      items.set(owner, [...held, { title: c.title, ...(moved && { focus: moved }) }]);
      const ack = accepted.get(JSON.stringify([task.id, task.resultRevisionId, c.id]));
      if (ack)
        resolved.set(`${owner}\0${held.length}`, {
          by: ack.payload.by,
          at: ack.createdAt,
          thread: ack.threadId,
        });
    }

  for (const [id, v] of versions) {
    const toCheck = items.get(id);
    if (toCheck) v.payload.toCheck = toCheck;
    out.push({
      id: idOf(id),
      threadId: v.event.threadId,
      createdAt: v.event.createdAt,
      type: "output.published",
      payload: v.payload,
    });
    report.published.push(id);
  }
  for (const [key, r] of resolved) {
    const [output, item] = key.split("\0") as [string, string];
    out.push({
      id: idOf(`resolved:${output}:${item}`),
      threadId: r.thread,
      createdAt: r.at,
      type: "tocheck.resolved",
      payload: { output, version: 1, item: Number(item), by: r.by, outcome: "accepted" },
    });
  }

  // Listed outputs nothing covers are marked missing, with the task's reason where it gave one.
  const missing = [...listed]
    .filter((id) => !covers(id))
    .map((id) => ({ id, reason: reportedMissing.get(id) ?? MISSING_REASON }));
  report.missing = missing;
  if (missing.length > 0)
    out.push({
      id: idOf("missing"),
      threadId: root.threadId,
      createdAt: events.at(-1)?.createdAt ?? opening.createdAt,
      type: "outputs.changed",
      payload: { by: "rule", reason: "The run ended without these outputs.", missing },
    });
  return { events: out, report };
}

/** What the version holds, from the task's report; a string says why none can be made. */
function versionOf(
  entry: OutputEntry,
  output: Output,
  event: Ev<"output">,
):
  | string
  | {
      files?: { root: "outputs" | "scratch"; path: string; sha256: string }[];
      value?: { number: number; unit: string };
      detail?: Record<string, unknown>;
    } {
  const wants = (ok: boolean, what: string) => (ok ? undefined : `the catalog lists it as ${what}`);
  switch (output.kind) {
    case "measurement": {
      const bad = wants(entry.kind === "value", entry.kind);
      if (bad) return bad;
      if (entry.kind !== "value") return "not a value";
      if (output.value === null) return "no value was reported";
      if (ucum(output.unit) !== entry.unit)
        return `its unit ${output.unit} is not the catalog's ${entry.unit}`;
      return { value: { number: output.value, unit: entry.unit } };
    }
    case "file":
      return entry.kind === "file"
        ? { files: [output.file] }
        : `the catalog lists it as ${entry.kind}`;
    case "volume": {
      const v = output.volume;
      const fits =
        v.kind === "image"
          ? entry.kind === "base"
          : entry.kind === "overlay" && entry.shape === "labels" && !entry.label;
      if (!fits) return `a ${v.kind} volume, but the catalog lists it as ${entry.kind}`;
      return {
        files: [v.file],
        detail: {
          dtype: v.dtype,
          gridId: v.gridId,
          affine: v.affine,
          ...(entry.kind === "base" && v.unit && { unit: v.unit }),
        },
      };
    }
    case "structure": {
      const s = output.structure;
      if ("label" in s) return "a label, which its map covers";
      if (entry.kind !== "overlay" || entry.shape !== "mask")
        return "a mask, but the catalog lists no mask";
      return {
        files: [s.mask],
        detail: { gridId: s.gridId, offsetZyx: s.offsetZyx, dtype: "uint8" },
      };
    }
    case "surface":
      if (entry.kind !== "overlay" || entry.shape !== "surface")
        return "a surface, but the catalog lists none";
      return {
        files: [output.surface.heights],
        detail: { gridId: output.surface.gridId, axis: output.surface.axis, dtype: "float32" },
      };
    case "annotation": {
      const shape = output.annotation.kind;
      if (entry.kind !== "overlay" || entry.shape !== shape)
        return `a ${shape}, but the catalog lists none`;
      // The agent loop keeps the annotation's object in a JSON file; the task kept it in the event, and its first JSON file is the closest.
      const json = event.payload.evidence.find(
        (r) => r.root === "outputs" && r.path.endsWith(".json"),
      );
      return json
        ? { files: [json], detail: { gridId: output.annotation.gridId } }
        : "it has no JSON file to hold it";
    }
    case "score":
      return "scores have no place in the catalog";
    case "missing":
      return "reported missing";
  }
}

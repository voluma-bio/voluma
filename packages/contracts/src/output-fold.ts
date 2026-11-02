/**
 * The agent model's output fold: the run's final outputs, every published version, each
 * output's status, and which outputs are out of date. Pure, events in `seq` order in, plain data
 * out, memoized on the log's length; the task loop's rows (`fold.ts`) stay as they are and ignore
 * what is here. Rules: the design's `outputs.md`; the tools that write the events are the
 * harness's `agents/tools/`.
 *
 * - **Final outputs.** `outputs.changed` events applied in order by `applyOutputsChange`
 *   (`final-outputs.ts`), which takes any change: the writer checks it first and refuses.
 * - **Versions.** `output.published` events (the task loop's `output` is ignored). A repeated
 *   (output, version) keeps the first. `by` is the thread's name from `thread.started`.
 * - **Status**, one per output: `missing` (marked, nothing published), `pending` (nothing
 *   published), `out-of-date`, `to-check` (an item of the latest version is unresolved: an item of
 *   an older version is answered by the newer one), else `reported`.
 * - **Out of date** (`outputs.md`, "Stale"). An output is out of date when its latest version
 *   links a version of another output that is no longer that output's latest by content, or
 *   links an output that is itself out of date. Content is every file's sha256 keyed by file
 *   name (a value: its number and unit), so a redo that produces the same files changes nothing,
 *   a kept version (same files) clears everything below it, and a change to a support file counts.
 *   A link to the output's own earlier version is ignored. A link to a label overlay (an entry
 *   of an `outputs.changed` with `label: {of}`) is a link to its map.
 * - **Undecided**: out of date and in the trail of a final output (the output itself, or
 *   something its latest version was made from, through latest versions). Main's `close` is
 *   refused while one exists.
 */
import type { z } from "zod";
import type { toCheckItemSchema } from "./agent-events";
import type { RunEvent } from "./events";
import { applyOutputsChange, entriesOf, type FinalEntry, type FinalOutputs } from "./final-outputs";
import type { LinkRole, OutputKind } from "./output-catalog";

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

/** The sandbox path of a version's folder: a version's `path` is relative to `/outputs/`. */
export const OUTPUTS_MOUNT = "/outputs";

// ---------------------------------------------------------------------------------------------
// Versions and status

type ToCheckState = z.infer<typeof toCheckItemSchema> & {
  /** Set when the researcher accepted or corrected it (`tocheck.resolved`). */
  resolved?: { by: string; outcome: "accepted" | "corrected" };
};

export interface OutputVersion {
  version: number;
  /** The name of the thread that reported it (`thread.started`), else the thread id. */
  by: string;
  at: string;
  /** The folder of its files, relative to `/outputs/`; the files are `/outputs/<path>/<file>`. */
  path: string;
  /** The first is the primary file, the output's own; the rest travel with it. Empty for a value. */
  files: { name: string; sha256: string }[];
  /** A value's number and unit. */
  value?: { number: number; unit: string };
  madeFrom: { id: string; version: number; role: LinkRole }[];
  /** Files that show why it is right, `evidence/...` under the version's folder. */
  evidence: { name: string; sha256: string }[];
  /** What the review converter needs per kind (`outputPublishedSchema`). */
  detail?: Record<string, unknown>;
  toCheck: ToCheckState[];
  provisional: boolean;
  kept?: { reason: string };
  /** What "latest by hash" compares: every file's sha256 keyed by name, or a value and its unit. */
  hash: string;
}

export type OutputStatus = "pending" | "reported" | "to-check" | "missing" | "out-of-date";

export interface OutputState {
  /** A catalog id, or `<worker>/<id>` for one the workflow did not declare. */
  id: string;
  kind?: OutputKind;
  base?: string;
  /** False for an output a worker reported that the catalog does not declare. */
  declared: boolean;
  /** In the run's final outputs now. */
  final: boolean;
  /** The final list's entry, for a final output. */
  entry?: FinalEntry;
  status: OutputStatus;
  /** Why it is marked missing, for a final output marked so. */
  missingReason?: string;
  outOfDate: boolean;
  /** Out of date, and in a final output's trail: main must decide it before it closes. */
  undecided: boolean;
  /** Oldest first. */
  versions: OutputVersion[];
  latest?: OutputVersion;
}

export interface OutputsFold {
  /** Undefined before the run's first `outputs.changed`. */
  list?: FinalOutputs;
  /** Final outputs in section order, then the other published ones in order of first version. */
  outputs: OutputState[];
  byId: Map<string, OutputState>;
  /** Each label overlay the log names, to the map whose version a link to it means. */
  labels: Map<string, string>;
}

const isLabel = (e: FinalEntry): e is FinalEntry & { label: { of: string } } =>
  typeof e.label === "object" &&
  e.label !== null &&
  typeof (e.label as { of?: unknown }).of === "string";

const hashOf = (v: Pick<OutputVersion, "files" | "value">): string =>
  v.value
    ? `value\0${v.value.unit}\0${v.value.number}`
    : v.files
        .map((f) => `${f.name}\0${f.sha256}`)
        .sort()
        .join("\n");

function versionOf(e: Ev<"output.published">, names: Map<string, string>): OutputVersion {
  const p = e.payload;
  const v: Omit<OutputVersion, "hash"> = {
    version: p.version,
    by: names.get(e.threadId) ?? e.threadId,
    at: e.createdAt,
    path: p.path,
    files: p.files ?? [],
    ...(p.value && { value: p.value }),
    madeFrom: p.madeFrom,
    evidence: p.evidence ?? [],
    ...(p.detail && { detail: p.detail }),
    toCheck: p.toCheck ?? [],
    provisional: p.provisional === true,
    ...(p.kept && { kept: p.kept }),
  };
  return { ...v, hash: hashOf(v) };
}

function compute(events: readonly RunEvent[]): OutputsFold {
  const names = new Map<string, string>();
  const versions = new Map<string, OutputVersion[]>();
  const kinds = new Map<string, { kind?: OutputKind; base?: string }>();
  const resolved = new Map<string, NonNullable<ToCheckState["resolved"]>>();
  /** A label overlay to the map that holds its voxels. */
  const labels = new Map<string, string>();
  let list: FinalOutputs | undefined;

  for (const e of events) {
    switch (e.type) {
      case "thread.started":
        names.set(e.threadId, e.payload.name);
        break;
      case "outputs.changed": {
        list = applyOutputsChange(list, e.payload, e.createdAt);
        for (const entry of e.payload.add ?? [])
          if (isLabel(entry)) labels.set(entry.id, entry.label.of);
        break;
      }
      case "output.published": {
        const v = versionOf(e, names);
        const id = e.payload.outputId;
        const held = versions.get(id) ?? [];
        if (held.some((x) => x.version === v.version)) break;
        versions.set(
          id,
          [...held, v].sort((a, b) => a.version - b.version),
        );
        if (!kinds.has(id)) kinds.set(id, { kind: e.payload.kind, base: e.payload.base });
        break;
      }
      case "tocheck.resolved": {
        const { output, version, item, by, outcome } = e.payload;
        resolved.set(`${output}\0${version}\0${item}`, { by, outcome });
        break;
      }
      default:
        break;
    }
  }
  for (const [id, vs] of versions)
    for (const v of vs)
      v.toCheck = v.toCheck.map((item, i) => {
        const r = resolved.get(`${id}\0${v.version}\0${i}`);
        return r ? { ...item, resolved: r } : item;
      });

  // Out of date, from the latest version of each output.
  const mapOf = (id: string) => labels.get(id) ?? id;
  const latestOf = (id: string) => versions.get(mapOf(id))?.at(-1);
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const outOfDate = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const latest = latestOf(id);
    if (!latest || visiting.has(id)) return false;
    visiting.add(id);
    const stale = latest.madeFrom.some((link) => {
      const linked = mapOf(link.id);
      if (linked === id) return false;
      const target = latestOf(linked);
      if (!target) return false;
      const used = versions.get(linked)?.find((v) => v.version === link.version);
      return !used || used.hash !== target.hash || outOfDate(linked);
    });
    visiting.delete(id);
    memo.set(id, stale);
    return stale;
  };

  // The trail of the final outputs: the outputs their latest versions were made from, recursively.
  const finalEntries = entriesOf(list);
  const trail = new Set<string>();
  const walk = (id: string) => {
    if (trail.has(id)) return;
    trail.add(id);
    for (const link of latestOf(id)?.madeFrom ?? []) walk(mapOf(link.id));
  };
  for (const e of finalEntries) walk(e.id);

  const missing = new Map((list?.missing ?? []).map((m) => [m.id, m.reason]));
  const ids = [...new Set([...finalEntries.map((e) => e.id), ...versions.keys()])];

  const outputs = ids.map((id): OutputState => {
    const vs = versions.get(id) ?? [];
    const latest = vs.at(-1);
    const entry = finalEntries.find((e) => e.id === id);
    const stale = outOfDate(id);
    const kind = kinds.get(id);
    const baseOf = kind?.base ?? (typeof entry?.base === "string" ? entry.base : undefined);
    const status: OutputStatus = !latest
      ? missing.has(id)
        ? "missing"
        : "pending"
      : stale
        ? "out-of-date"
        : latest.toCheck.some((t) => !t.resolved)
          ? "to-check"
          : "reported";
    return {
      id,
      declared: !id.includes("/"),
      final: !!entry,
      ...((entry?.kind ?? kind?.kind) && { kind: entry?.kind ?? kind?.kind }),
      ...(baseOf && { base: baseOf }),
      ...(entry && { entry }),
      status,
      ...(missing.has(id) && !latest && { missingReason: missing.get(id) }),
      outOfDate: stale,
      undecided: stale && trail.has(id),
      versions: vs,
      ...(latest && { latest }),
    } as OutputState;
  });
  return { ...(list && { list }), outputs, byId: new Map(outputs.map((o) => [o.id, o])), labels };
}

const memo = new WeakMap<object, { length: number; fold: OutputsFold }>();

/** The fold of `events`, recomputed only when the log has grown (the log array may be appended to in place). */
export function outputsFold(events: readonly RunEvent[]): OutputsFold {
  const held = memo.get(events);
  if (held && held.length === events.length) return held.fold;
  const fold = compute(events);
  memo.set(events, { length: events.length, fold });
  return fold;
}

// ---------------------------------------------------------------------------------------------
// What the run loop needs (design-c1.md, section 2)

/** The run's final outputs with their status, in section order. */
export const finalOutputs = (events: readonly RunEvent[]): OutputState[] =>
  outputsFold(events).outputs.filter((o) => o.final);

/** Final outputs with no version that are not marked missing. */
export const pendingFinal = (events: readonly RunEvent[]): string[] =>
  finalOutputs(events)
    .filter((o) => o.status === "pending")
    .map((o) => o.id);

/** Out-of-date outputs in a final output's trail: main must keep or redo them before it closes. */
export const undecidedOutOfDate = (events: readonly RunEvent[]): string[] =>
  outputsFold(events)
    .outputs.filter((o) => o.undecided)
    .map((o) => o.id);

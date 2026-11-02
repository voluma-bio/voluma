/**
 * The agent model's output fold: the run's final outputs, every published version, each
 * output's status, and which outputs are out of date. Pure, events in `seq` order in, plain data
 * out, memoized on the log's length; the task loop's rows (`fold.ts`) stay as they are and ignore
 * what is here. Rules: the design's `outputs.md`; the tools that write the events are the
 * harness's `agents/tools/`.
 *
 * - **Final outputs.** `outputs.changed` events applied in order by `applyOutputsChange`, which
 *   the `change_outputs` tool calls too, so the tool refuses what the fold would reject. A change
 *   the rules refuse is skipped.
 * - **Versions.** An `output` event with a `version` (the task loop's carry none and are skipped).
 *   A repeated (output, version) keeps the first. `by` is the thread's name from `thread.started`.
 * - **Status**, one per output: `missing` (marked, nothing published), `pending` (nothing
 *   published), `out-of-date`, `to-check` (an item of the latest version is unresolved: an item of
 *   an older version is answered by the newer one), else `reported`.
 * - **Out of date** (`outputs.md`, "Stale"). An output is out of date when its latest version
 *   links a version of another output that is no longer that output's latest by content, or
 *   links an output that is itself out of date. Content is every file's sha256 keyed by file
 *   name (a value: its number and unit), so a redo that produces the same files changes nothing,
 *   a kept version (same files) clears everything below it, and a change to a support file counts.
 *   A link to the output's own earlier version is ignored.
 * - **Undecided**: out of date and in the trail of a final output (the output itself, or
 *   something its latest version was made from, through latest versions). Main's `close` is
 *   refused while one exists.
 */
import type { z } from "zod";
import type { OutputsChange, toCheckItemSchema } from "./agent-events";
import type { RunEvent } from "./events";
import type { EvidenceRef } from "./output";
import {
  type FinalOutputs,
  finalOutputsSchema,
  type LinkRole,
  type OutputEntry,
  type OutputKind,
} from "./output-catalog";

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

/** The sandbox path of a version's folder: a version's `path` is relative to `/outputs/`. */
export const OUTPUTS_MOUNT = "/outputs";

// ---------------------------------------------------------------------------------------------
// Final outputs

const OTHER = "Other";

const sectionsOf = (list: FinalOutputs | undefined) => list?.sections ?? [];

/** Every entry of the list, in section order. */
export const entriesOf = (list: FinalOutputs | undefined): OutputEntry[] =>
  sectionsOf(list).flatMap((s) => s.outputs);

/**
 * The list after `change`, or the reason it cannot apply. `list` is undefined before the first
 * change. Order: `drop`, `add`, `missing`, `expect`, then `sections`, each checked against the
 * list as the steps before it left it. Outputs left out of `sections` (new ones, when it is
 * absent) go in a section titled "Other". The result is checked as `/run/final-outputs.yaml`
 * (`finalOutputsSchema`): a link to an output that is not listed, or an emptied list, is refused.
 */
export function applyOutputsChange(
  list: FinalOutputs | undefined,
  change: OutputsChange,
  at: string,
): { list: FinalOutputs } | { refusal: string } {
  const sections = sectionsOf(list).map((s) => ({ title: s.title, outputs: [...s.outputs] }));
  const have = () => new Set(sections.flatMap((s) => s.outputs.map((o) => o.id)));
  const ungrouped: OutputEntry[] = [];
  let missing = [...(list?.missing ?? [])];

  for (const id of change.drop ?? []) {
    if (!have().has(id)) return { refusal: `${id} is not a final output, so it cannot be dropped` };
    for (const s of sections) s.outputs = s.outputs.filter((o) => o.id !== id);
    missing = missing.filter((m) => m.id !== id);
  }
  for (const entry of change.add ?? []) {
    if (have().has(entry.id) || ungrouped.some((o) => o.id === entry.id))
      return { refusal: `${entry.id} is already a final output` };
    ungrouped.push(entry);
  }
  const listed = new Set([...have(), ...ungrouped.map((o) => o.id)]);
  for (const m of change.missing ?? []) {
    if (!listed.has(m.id))
      return { refusal: `${m.id} is not a final output, so it cannot be missing` };
    missing = [...missing.filter((x) => x.id !== m.id), m];
  }
  const entries = new Map<string, OutputEntry>();
  for (const e of [...sections.flatMap((s) => s.outputs), ...ungrouped]) entries.set(e.id, e);
  for (const x of change.expect ?? []) {
    const e = entries.get(x.id);
    if (!e) return { refusal: `${x.id} is not a final output, so it takes no expect lines` };
    entries.set(x.id, { ...e, expect: [...(e.expect ?? []), ...x.lines] });
  }

  let grouped = sections.map((s) => ({ title: s.title, ids: s.outputs.map((o) => o.id) }));
  if (change.sections) {
    const seen = new Set<string>();
    for (const s of change.sections)
      for (const id of s.outputs) {
        if (!entries.has(id))
          return { refusal: `${id} is not a final output, so it has no section` };
        if (seen.has(id)) return { refusal: `${id} is in two sections` };
        seen.add(id);
      }
    grouped = change.sections.map((s) => ({ title: s.title, ids: s.outputs }));
  }
  const placed = new Set(grouped.flatMap((s) => s.ids));
  const rest = [...entries.keys()].filter((id) => !placed.has(id));
  if (rest.length > 0) {
    const other = grouped.find((s) => s.title === OTHER);
    if (other) other.ids = [...other.ids, ...rest];
    else grouped.push({ title: OTHER, ids: rest });
  }

  const next: FinalOutputs = {
    sections: grouped
      .filter((s) => s.ids.length > 0)
      .map((s) => ({
        title: s.title,
        outputs: s.ids.flatMap((id) => entries.get(id) ?? []),
      })),
    ...(missing.length > 0 && { missing }),
    changes: [
      ...(list?.changes ?? []),
      {
        at,
        by: change.by,
        reason: change.reason,
        ...(change.add && { add: change.add.map((e) => e.id) }),
        ...(change.drop && { drop: change.drop }),
        ...(change.missing && { missing: change.missing.map((m) => m.id) }),
      },
    ],
  };
  const checked = finalOutputsSchema.safeParse(next);
  if (!checked.success)
    return {
      refusal: checked.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join("; "),
    };
  return { list: next };
}

// ---------------------------------------------------------------------------------------------
// Versions and status

export type ToCheckState = z.infer<typeof toCheckItemSchema> & {
  /** Set when the researcher accepted or corrected it (`tocheck.resolved`). */
  resolved?: { by: string; outcome: "accepted" | "corrected" };
};

export interface OutputVersion {
  version: number;
  eventId: string;
  /** The name of the thread that reported it (`thread.started`), else the thread id. */
  by: string;
  at: string;
  /** The folder of its files, relative to `/outputs/`; the files are `/outputs/<path>/<file>`. */
  path: string;
  /** The first is the primary file, the output's own; the rest travel with it. Empty for a value. */
  files: { path: string; sha256: string }[];
  /** A value's number and unit. */
  value?: { number: number; unit: string };
  madeFrom: { id: string; version: number; role: LinkRole }[];
  evidence: EvidenceRef[];
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
  section?: string;
  /** The final list's entry, for a final output. */
  entry?: OutputEntry;
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
}

const hashOf = (v: Pick<OutputVersion, "files" | "value">): string =>
  v.value
    ? `value\0${v.value.unit}\0${v.value.number}`
    : v.files
        .map((f) => `${f.path}\0${f.sha256}`)
        .sort()
        .join("\n");

function versionOf(e: Ev<"output">, names: Map<string, string>): OutputVersion | undefined {
  const p = e.payload;
  if (p.version === undefined || p.path === undefined) return undefined;
  const nested = p.output;
  const v: Omit<OutputVersion, "hash"> = {
    version: p.version,
    eventId: e.id,
    by: names.get(e.threadId) ?? e.threadId,
    at: e.createdAt,
    path: p.path,
    files: p.files ?? [],
    ...(nested.kind === "measurement" &&
      nested.value !== null && { value: { number: nested.value, unit: nested.unit } }),
    madeFrom: p.madeFrom ?? [],
    evidence: p.evidence,
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
  let list: FinalOutputs | undefined;

  for (const e of events) {
    switch (e.type) {
      case "thread.started":
        names.set(e.threadId, e.payload.name);
        break;
      case "outputs.changed": {
        const applied = applyOutputsChange(list, e.payload, e.createdAt);
        if ("list" in applied) list = applied.list;
        break;
      }
      case "output": {
        const v = versionOf(e, names);
        if (!v) break;
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
  const latestOf = (id: string) => versions.get(id)?.at(-1);
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const outOfDate = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const latest = latestOf(id);
    if (!latest || visiting.has(id)) return false;
    visiting.add(id);
    const stale = latest.madeFrom.some((link) => {
      if (link.id === id) return false;
      const target = latestOf(link.id);
      if (!target) return false;
      const used = versions.get(link.id)?.find((v) => v.version === link.version);
      return !used || used.hash !== target.hash || outOfDate(link.id);
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
    for (const link of latestOf(id)?.madeFrom ?? []) walk(link.id);
  };
  for (const e of finalEntries) walk(e.id);

  const sectionOf = new Map<string, string>();
  for (const s of sectionsOf(list)) for (const o of s.outputs) sectionOf.set(o.id, s.title);
  const missing = new Map((list?.missing ?? []).map((m) => [m.id, m.reason]));
  const ids = [...new Set([...finalEntries.map((e) => e.id), ...versions.keys()])];

  const outputs = ids.map((id): OutputState => {
    const vs = versions.get(id) ?? [];
    const latest = vs.at(-1);
    const entry = finalEntries.find((e) => e.id === id);
    const stale = outOfDate(id);
    const kind = kinds.get(id);
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
      ...((entry?.kind === "overlay" ? entry.base : kind?.base) && {
        base: entry?.kind === "overlay" ? entry.base : kind?.base,
      }),
      ...(sectionOf.has(id) && { section: sectionOf.get(id) }),
      ...(entry && { entry }),
      status,
      ...(missing.has(id) && !latest && { missingReason: missing.get(id) }),
      outOfDate: stale,
      undecided: stale && trail.has(id),
      versions: vs,
      ...(latest && { latest }),
    } as OutputState;
  });
  return { ...(list && { list }), outputs, byId: new Map(outputs.map((o) => [o.id, o])) };
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

/** An output's latest version, with its hash; undefined while nothing is published. */
export const latest = (events: readonly RunEvent[], id: string): OutputVersion | undefined =>
  outputsFold(events).byId.get(id)?.latest;

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

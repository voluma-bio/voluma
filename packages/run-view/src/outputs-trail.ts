/**
 * How the AI got to an output, from the output fold: the trail behind one output (what its
 * latest version was made from, recursively), the whole run's made-from graph, a version's
 * report, and the run's agents (`agentLog`). Pure data; the input review draws it (the trail panel,
 * the whole-run graph, Run details), so a new look changes only the drawing. Rules: the agent-model
 * design's `review.md` (Layout, Panels and views) and `outputs.md` (Stale).
 *
 * A link to a label overlay (a bone of
 * the labels map) is a link to its map (`resolveLink`): an overlay has no versions, the version it
 * names is the map's. A link from an output to its own earlier version is not drawn.
 *
 * Two walks share one breadth-first walker (`walk`): the trail behind a published version
 * (`trailOf`, every `madeFrom`) and the chain a final value is computed on (`chainOf`, its spine:
 * what it is measured on, a label's map, an overlay's base, a base's `from`), which exists before
 * anything is published and follows the published links once they do.
 */
import { type AgentState, agentLog, agentState } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import type { LinkRole, OutputCatalog } from "@voluma/contracts/output-catalog";
import type {
  OutputState,
  OutputStatus,
  OutputsFold,
  OutputVersion,
} from "@voluma/contracts/output-fold";

/** What a link's role says in a row: how the output above uses this one. */
export const ROLE_WORD: Record<LinkRole, string> = {
  on: "Measurement region",
  context: "Visual context",
  base: "Reference image",
  input: "Source data",
};

export type TrailRow = {
  id: string;
  /** Links from the root: 0 is the root. */
  depth: number;
  state: OutputState | undefined;
  /** How the first row above that links it uses it; absent on the root. */
  role?: LinkRole;
  /** The version that row used; absent on the root (its latest). */
  used?: number;
  /** The version used is not the output's latest. */
  superseded: boolean;
  /** Indexes of the rows it was made from, through its latest version. */
  from: number[];
};

/** What a link to `id` is a link to: its map for a label overlay (it has no versions), else `id`. The fold resolved it. */
export const resolveLink = (fold: OutputsFold, id: string) => fold.labels.get(id) ?? id;

type Link = { id: string; role?: LinkRole; version?: number };

/** The latest version's links, resolved, self-links dropped, the first of each output kept. */
function linksOf(fold: OutputsFold, id: string): OutputVersion["madeFrom"] {
  const seen = new Set<string>();
  const links: OutputVersion["madeFrom"] = [];
  for (const link of fold.byId.get(id)?.latest?.madeFrom ?? []) {
    const to = resolveLink(fold, link.id);
    if (to === id || seen.has(to)) continue;
    seen.add(to);
    links.push({ ...link, id: to });
  }
  return links;
}

/**
 * From `root` along `linksOf`, breadth first, so a row sits below every row that links it at a
 * shorter distance. Each output appears once, at its first distance.
 */
function walk(fold: OutputsFold, root: string, next: (id: string) => Link[]): TrailRow[] {
  const rows: TrailRow[] = [
    { id: root, depth: 0, state: fold.byId.get(root), superseded: false, from: [] },
  ];
  const index = new Map([[root, 0]]);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (const link of next(row.id)) {
      let at = index.get(link.id);
      if (at === undefined) {
        const state = fold.byId.get(link.id);
        at = rows.length;
        index.set(link.id, at);
        rows.push({
          id: link.id,
          depth: row.depth + 1,
          state,
          ...(link.role && { role: link.role }),
          ...(link.version !== undefined && { used: link.version }),
          superseded:
            link.version !== undefined && !!state?.latest && state.latest.version !== link.version,
          from: [],
        });
      }
      row.from.push(at);
    }
  }
  return rows;
}

/** The trail behind `id`: the root, then what its latest version was made from, recursively. */
export const trailOf = (fold: OutputsFold, id: string): TrailRow[] =>
  walk(fold, resolveLink(fold, id), (at) => linksOf(fold, at));

/** One link of a chain: absent `status` while nothing of it is published. */
export type ChainLink = { id: string; status?: OutputStatus };

/**
 * One step back along the spine: the published version's `on` links, else its `base` links (a
 * base's links to other bases), else the catalog's (a label's map, an overlay's base, a base's
 * `from`). `on` is a value's measured-on overlays (`OutputRow.on`, catalog and published).
 */
function spineOf(fold: OutputsFold, catalog: OutputCatalog, id: string, on: string[]): Link[] {
  const state = fold.byId.get(id);
  const entry = catalog.find((e) => e.id === id);
  const kind = entry?.kind ?? state?.kind;
  if (kind === "value") return on.map((to) => ({ id: to }));
  const kindOf = (other: string) =>
    catalog.find((e) => e.id === other)?.kind ?? fold.byId.get(other)?.kind;
  const made = (state?.latest?.madeFrom ?? []).filter((l) => l.id !== id);
  const published =
    kind === "base"
      ? made.filter((l) => kindOf(l.id) === "base")
      : [made.filter((l) => l.role === "on"), made.filter((l) => l.role === "base")].find(
          (ls) => ls.length > 0,
        );
  if (published?.length) return published.map((l) => ({ id: l.id }));
  const map = resolveLink(fold, id);
  if (map !== id) return [{ id: map }];
  const back =
    entry?.kind === "overlay" ? entry.base : entry?.kind === "base" ? entry.from : state?.base;
  return back ? [{ id: back }] : [];
}

/**
 * The chain a final output rests on, one array per step back, nearest first ("Patella ‹ Bone
 * labels ‹ Scan"). Each link is ticked by its status, which for a label overlay is its map's;
 * one with nothing published (pending or missing) is not yet in.
 */
export function chainOf(
  fold: OutputsFold,
  catalog: OutputCatalog,
  id: string,
  on: string[],
): ChainLink[][] {
  const rows = walk(fold, id, (at) => spineOf(fold, catalog, at, on));
  const steps: ChainLink[][] = [];
  for (const r of rows.slice(1)) {
    const step = steps[r.depth - 1] ?? [];
    steps[r.depth - 1] = step;
    // A label overlay has no versions of its own: its status is its map's.
    const status = fold.byId.get(resolveLink(fold, r.id))?.status;
    step.push({
      id: r.id,
      ...(status && status !== "pending" && status !== "missing" && { status }),
    });
  }
  return steps;
}

/** Every output whose latest version was made, directly or not, from `id`. */
export function madeFromIt(fold: OutputsFold, id: string): Set<string> {
  const users = new Map<string, string[]>();
  for (const o of fold.outputs)
    for (const link of linksOf(fold, o.id))
      users.set(link.id, [...(users.get(link.id) ?? []), o.id]);
  const out = new Set<string>();
  const visit = (at: string) => {
    for (const next of users.get(at) ?? [])
      if (!out.has(next)) {
        out.add(next);
        visit(next);
      }
  };
  visit(resolveLink(fold, id));
  return out;
}

export type GraphNode = {
  id: string;
  state: OutputState;
  /** 0 for what was made from nothing; else one past the furthest output it was made from. Final outputs take the last column. */
  column: number;
};

export type RunGraph = {
  nodes: GraphNode[];
  links: { from: string; to: string; role: LinkRole }[];
  columns: number;
};

/** The whole run's made-from graph: every output with a version, and every final output, by column. */
export function runGraph(fold: OutputsFold): RunGraph {
  const published = fold.outputs.filter((o) => o.latest || o.final);
  const has = new Set(published.map((o) => o.id));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(
      0,
      ...linksOf(fold, id)
        .filter((l) => has.has(l.id))
        .map((l) => depth(l.id) + 1),
    );
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  const inner = published.filter((o) => !o.final);
  const last = Math.max(0, ...inner.map((o) => depth(o.id) + 1));
  const nodes = published.map((o) => ({
    id: o.id,
    state: o,
    column: o.final ? last : depth(o.id),
  }));
  const links = published.flatMap((o) =>
    linksOf(fold, o.id)
      .filter((l) => has.has(l.id))
      .map((l) => ({ from: l.id, to: o.id, role: l.role })),
  );
  return { nodes, links, columns: last + 1 };
}

/**
 * What the worker said when it reported `version`: its first message to another agent after the
 * version, by its thread's name. Undefined when it said nothing after it.
 */
export function versionWords(events: readonly RunEvent[], v: OutputVersion): string | undefined {
  const at = events.findIndex((e) => e.id === v.eventId);
  if (at < 0) return undefined;
  for (let i = at + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "agent.message" && e.payload.from === v.by && e.payload.to !== "researcher")
      return e.payload.text;
  }
  return undefined;
}

export type Worker = {
  id: string;
  name: string;
  /** Its first start and latest end; no end while it works. */
  from: string;
  to?: string;
  /** `agentState` with `live` standing for "the runner runs it": a run's open thread works. */
  state: AgentState;
  /** Its latest end was a cancellation (a stop), not a close. */
  stopped: boolean;
  /** The outputs it reported, in order of first version. */
  made: string[];
};

/**
 * The run's agents (`agentLog`, without the supervisor), in order of first start. `live`: the run
 * has not ended, so a thread with no end is at work; on an ended run it was cut off.
 */
export function workersOf(events: readonly RunEvent[], fold: OutputsFold, live: boolean): Worker[] {
  const log = agentLog(events);
  const firstStart = new Map<string, string>();
  for (const e of events)
    if (e.type === "thread.started" && !firstStart.has(e.threadId))
      firstStart.set(e.threadId, e.createdAt);
  const workers = [...log.records.values()].map(
    (r): Worker => ({
      id: r.id,
      name: r.name,
      from: firstStart.get(r.id) ?? r.endedTime,
      ...(r.end && { to: r.endedTime }),
      state: agentState(r, live && r.end === undefined),
      stopped: r.end?.status === "cancelled",
      made: [],
    }),
  );
  // A version names its thread by name; the event it came in says which thread it was.
  const byId = new Map(workers.map((w) => [w.id, w]));
  for (const o of fold.outputs)
    for (const v of o.versions) {
      const at = log.written.get(v.eventId);
      const w = at === undefined ? undefined : byId.get(events[at]!.threadId);
      if (w && !w.made.includes(o.id)) w.made.push(o.id);
    }
  return workers;
}

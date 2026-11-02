/**
 * How the AI got to an output, from the output fold: the trail behind one output (what its
 * latest version was made from, recursively), the whole run's made-from graph, a version's
 * report, and the run's workers by name. Pure data; the scan review draws it (the trail panel,
 * the whole-run graph, Run details), so a new look changes only the drawing. Rules: the agent-model
 * design's `review.md` (Layout, Panels and views) and `outputs.md` (Stale).
 *
 * A link to a label overlay (a bone of the labels map) is a link to its map, as the fold has it.
 * A link from an output to its own earlier version is not drawn.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { LinkRole } from "@voluma/contracts/output-catalog";
import type { OutputState, OutputsFold, OutputVersion } from "@voluma/contracts/output-fold";

/** What a link's role says in a row: how the output above uses this one. */
export const ROLE_WORD: Record<LinkRole, string> = {
  on: "measured on",
  context: "beside",
  base: "drawn on",
  input: "made from",
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

const mapOf = (fold: OutputsFold, id: string) => fold.labels.get(id) ?? id;

/** The latest version's links, label links resolved and self-links dropped, first of each output kept. */
function linksOf(fold: OutputsFold, id: string): OutputVersion["madeFrom"] {
  const seen = new Set<string>();
  const links: OutputVersion["madeFrom"] = [];
  for (const link of fold.byId.get(id)?.latest?.madeFrom ?? []) {
    const to = mapOf(fold, link.id);
    if (to === id || seen.has(to)) continue;
    seen.add(to);
    links.push({ ...link, id: to });
  }
  return links;
}

/**
 * The trail behind `id`: the root, then what it was made from breadth first, so a row sits below
 * every row that links it at a shorter distance. Each output appears once.
 */
export function trailOf(fold: OutputsFold, id: string): TrailRow[] {
  const root = mapOf(fold, id);
  const rows: TrailRow[] = [
    { id: root, depth: 0, state: fold.byId.get(root), superseded: false, from: [] },
  ];
  const index = new Map([[root, 0]]);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (const link of linksOf(fold, row.id)) {
      let at = index.get(link.id);
      if (at === undefined) {
        const state = fold.byId.get(link.id);
        at = rows.length;
        index.set(link.id, at);
        rows.push({
          id: link.id,
          depth: row.depth + 1,
          state,
          role: link.role,
          used: link.version,
          superseded: !!state?.latest && state.latest.version !== link.version,
          from: [],
        });
      }
      row.from.push(at);
    }
  }
  return rows;
}

/** Every output whose latest version was made, directly or not, from `id`. */
export function madeFromIt(fold: OutputsFold, id: string): Set<string> {
  const users = new Map<string, string[]>();
  for (const o of fold.outputs)
    for (const link of linksOf(fold, o.id))
      users.set(link.id, [...(users.get(link.id) ?? []), o.id]);
  const out = new Set<string>();
  const walk = (at: string) => {
    for (const next of users.get(at) ?? [])
      if (!out.has(next)) {
        out.add(next);
        walk(next);
      }
  };
  walk(mapOf(fold, id));
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

/** The whole run's made-from graph: every output with a version, by column. */
export function runGraph(fold: OutputsFold): RunGraph {
  const published = fold.outputs.filter((o) => o.latest);
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
  name: string;
  kind: string;
  /** Its first start and last end; no end while it runs. */
  from: string;
  to?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "closed";
  /** The outputs it reported, in order of first version. */
  made: string[];
};

/** The run's agents by name, in order of first start, without the supervisor. */
export function workersOf(events: readonly RunEvent[], fold: OutputsFold): Worker[] {
  const byThread = new Map<string, Worker>();
  for (const e of events) {
    if (e.type === "thread.started") {
      if (e.payload.kind === "supervisor") continue;
      const had = byThread.get(e.threadId);
      byThread.set(e.threadId, {
        name: e.payload.name,
        kind: e.payload.kind,
        from: had?.from ?? e.createdAt,
        status: "running",
        made: had?.made ?? [],
      });
    } else if (e.type === "thread.ended") {
      const w = byThread.get(e.threadId);
      if (w) {
        w.to = e.createdAt;
        w.status = e.payload.status;
      }
    }
  }
  const workers = [...byThread.values()];
  const byName = new Map(workers.map((w) => [w.name, w]));
  for (const o of fold.outputs)
    for (const v of o.versions) {
      const w = byName.get(v.by);
      if (w && !w.made.includes(o.id)) w.made.push(o.id);
    }
  return workers;
}

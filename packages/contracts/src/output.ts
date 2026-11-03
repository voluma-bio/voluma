/**
 * What an agent's report names: a file it made, as recorded (`EvidenceRef`), and a position in a
 * grid. The published output versions are `agent-events.ts`; what an output may be is
 * `output-catalog.ts`.
 */
import { z } from "zod";
import { relativePathSchema, sha256Schema } from "./r2";

/**
 * A file the agent named, as recorded: copied to `evidenceKey(runId, sha256)`
 * before the event is appended, so a rerun can't erase it. `path` is under
 * `root`: `outputs` is the task's output folder (`outputKey`), `scratch` the
 * run's scratch (`scratchKey`), where a check thread keeps its reproductions. A tool call's
 * scratch path is relative to the caller's own folder unless it starts with a thread name;
 * the event holds the full form. The runtime scopes every path to this run.
 */
export const evidenceRefSchema = z.object({
  root: z.enum(["outputs", "scratch"]),
  path: relativePathSchema,
  sha256: sha256Schema,
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** A position in voxel coordinates `[z, y, x]` of a grid; fractional allowed. */
export const positionZyx = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

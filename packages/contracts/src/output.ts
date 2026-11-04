/**
 * What an agent's report names: a position in a grid. The published output versions are `agent-events.ts`; what an output may be is
 * `output-catalog.ts`.
 */
import { z } from "zod";

/** A position in voxel coordinates `[z, y, x]` of a grid; fractional allowed. */
export const positionZyx = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

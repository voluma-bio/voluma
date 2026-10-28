/**
 * The runner's history routes under
 * `/run/ingest/runs/:runId/threads/:threadId/messages`: the model's record of one thread, one row per Pi message, as a JSON string.
 * The client and the API parse with the same schemas. The run is in the path because a
 * thread's first history call comes before any event names the thread, so the server can
 * look the lease up only by the run. A thread id must begin with `<runId>.` (`ids.ts`: a
 * run id holds no '.'); anything else is 400.
 *
 *   GET  → 200 `historyResponseSchema`, rows in `idx` order
 *   POST → 204 with a `historyRowSchema` body. Appending the same `idx` with
 *          the same `message` is a no-op; a different `message` at an `idx`
 *          already stored is 409.
 *
 * Both carry the run's lease token (`LEASE_TOKEN_HEADER`, `runner.ts`); a stale
 * one is a 409 whose body is `leaseLostSchema`, which the runner tells apart
 * from the `idx` conflict and answers by stopping the run.
 */
import { z } from "zod";

export const historyRowSchema = z.object({
  idx: z.number().int().nonnegative(),
  message: z.string(),
});
export type HistoryRow = z.infer<typeof historyRowSchema>;

export const historyResponseSchema = z.object({ messages: z.array(z.string()) });
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * The react-query side of the client: one definition per query key (with its fetcher) and the
 * mutations that touch several of them, so every feature that reads or changes a run, a study or
 * a review shares the same cache entries. `@tanstack/react-query` is a peer: the app owns the
 * QueryClient. Call sites add their own options (`refetchInterval`, `enabled`) around these.
 */
import {
  type QueryClient,
  queryOptions,
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ReviewDecisionResponse } from "@voluma/contracts/review";
import {
  ApiError,
  acceptCheck,
  getReviewRun,
  getRun,
  getStudy,
  listInputs,
  listRuns,
  listStudies,
} from "./index";

export const runQuery = (id: string) =>
  queryOptions({ queryKey: ["run", id], queryFn: () => getRun(id) });
export const reviewRunQuery = (id: string) =>
  queryOptions({ queryKey: ["review-run", id], queryFn: () => getReviewRun(id) });
export const studiesQuery = () => queryOptions({ queryKey: ["studies"], queryFn: listStudies });
export const studyQuery = (id: string) =>
  queryOptions({ queryKey: ["study", id], queryFn: () => getStudy(id) });
export const runsQuery = () => queryOptions({ queryKey: ["runs"], queryFn: listRuns });
export const inputsQuery = () => queryOptions({ queryKey: ["inputs"], queryFn: listInputs });

/** Every study read, whichever study: `study` keys are `["study", id]`. */
export const allStudiesKey = ["study"] as const;

/** Refetches everything that shows a run's results or its open checks. */
export function invalidateRun(client: QueryClient, runId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: runQuery(runId).queryKey }),
    client.invalidateQueries({ queryKey: reviewRunQuery(runId).queryKey }),
    client.invalidateQueries({ queryKey: allStudiesKey }),
    client.invalidateQueries({ queryKey: studiesQuery().queryKey }),
  ]);
}

export type AcceptVars = { checkId: string; taskId: string };

/**
 * "Looks right": accepting one open check on a run's current result. One mutation and one error
 * rule for every place that offers it (the run page, the study's To check list, the task report),
 * so a failure reads the same wherever it happens. Callers show `mutation.error.message`.
 *
 * `revisionId` is the result the check belongs to; without one the mutation can't run (the
 * callers disable their button). A 409 means the result changed since the page loaded: the run,
 * review and study reads are refetched in the background to show the new one. After a success
 * the mutation stays pending until they land.
 */
export function useAcceptCheck(
  runId: string,
  revisionId: string | undefined,
  options: Pick<
    UseMutationOptions<ReviewDecisionResponse, Error, AcceptVars>,
    "onMutate" | "onSuccess" | "onSettled"
  > = {},
) {
  const client = useQueryClient();
  return useMutation<ReviewDecisionResponse, Error, AcceptVars>({
    ...options,
    mutationFn: async ({ checkId, taskId }) => {
      if (!revisionId) throw new Error("no completed result");
      try {
        return await acceptCheck(runId, checkId, { baseRevisionId: revisionId, taskId });
      } catch (e) {
        const status = e instanceof ApiError ? e.status : undefined;
        if (status === 409) void invalidateRun(client, runId);
        throw new Error(
          status === 403
            ? "You can view this run but not change it."
            : status === 409
              ? "This changed since you opened it. Look again."
              : "Couldn't save. Try again.",
        );
      }
    },
    onSuccess: async (...args) => {
      await Promise.all([options.onSuccess?.(...args), invalidateRun(client, runId)]);
    },
  });
}

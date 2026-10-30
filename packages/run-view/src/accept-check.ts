/**
 * "Looks right": accepting one open check on a run's current result. One mutation and one error
 * rule for every place that offers it (the run page, the study's To check list, the task report),
 * so a failure reads the same wherever it happens. Callers show `mutation.error.message`.
 */
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { ApiError, acceptCheck } from "@voluma/api-client";
import type { ReviewDecisionResponse } from "@voluma/contracts/review";

export type AcceptVars = { checkId: string; taskId: string };

/**
 * `revisionId` is the result the check belongs to; without one the mutation can't run (the
 * callers disable their button). A 409 means the result changed since the page loaded: `refetch`
 * shows the new one.
 */
export function useAcceptCheck(
  runId: string,
  revisionId: string | undefined,
  {
    refetch,
    ...options
  }: { refetch: () => unknown } & Pick<
    UseMutationOptions<ReviewDecisionResponse, Error, AcceptVars>,
    "onMutate" | "onSuccess" | "onSettled"
  >,
) {
  return useMutation<ReviewDecisionResponse, Error, AcceptVars>({
    ...options,
    mutationFn: async ({ checkId, taskId }) => {
      if (!revisionId) throw new Error("no completed result");
      try {
        return await acceptCheck(runId, checkId, { baseRevisionId: revisionId, taskId });
      } catch (e) {
        const status = e instanceof ApiError ? e.status : undefined;
        if (status === 409) refetch();
        throw new Error(
          status === 403
            ? "You can view this run but not change it."
            : status === 409
              ? "This changed since you opened it. Look again."
              : "Couldn't save. Try again.",
        );
      }
    },
  });
}

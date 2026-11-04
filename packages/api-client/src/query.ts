/**
 * The react-query side of the client: one definition per query key (with its fetcher) and the
 * mutations that touch several of them, so every feature that reads or changes a run, a study or
 * a review shares the same cache entries. `@tanstack/react-query` is a peer: the app owns the
 * QueryClient. Call sites add their own options (`refetchInterval`, `enabled`) around these, except
 * where the rule is the key's own (the live refetch of `studiesQuery` and `studyQuery`).
 */
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UpdateUserSettingsRequest } from "@voluma/contracts/settings";
import {
  getRun,
  getRunModels,
  getStudy,
  getUserSettings,
  listInputs,
  listRuns,
  listStudies,
  updateUserSettings,
} from "./index";

export const runQuery = (id: string) =>
  queryOptions({ queryKey: ["run", id], queryFn: () => getRun(id) });
/** The lab's studies, refetched every 5 s while any study's newest run is still going. */
export const studiesQuery = () =>
  queryOptions({
    queryKey: ["studies"],
    queryFn: listStudies,
    refetchInterval: (q) =>
      q.state.data?.some((s) => s.newestRuns.some((r) => r.state.status !== "ended"))
        ? 5000
        : false,
  });
/** One study, refetched every 5 s while any of its inputs' newest run is still going. */
export const studyQuery = (id: string) =>
  queryOptions({
    queryKey: ["study", id],
    queryFn: () => getStudy(id),
    refetchInterval: (q) =>
      q.state.data?.inputs.some((s) => s.runs[0] && s.runs[0].state.status !== "ended")
        ? 5000
        : false,
  });
export const runsQuery = () => queryOptions({ queryKey: ["runs"], queryFn: listRuns });
export const runModelsQuery = () =>
  queryOptions({ queryKey: ["run-models"], queryFn: getRunModels });
export const inputsQuery = () => queryOptions({ queryKey: ["inputs"], queryFn: listInputs });

/** Identity scopes the cache only; the server always takes the user from the session. */
export const userSettingsQuery = (userId: string) =>
  queryOptions({ queryKey: ["user-settings", userId], queryFn: getUserSettings });

export function useUpdateUserSettings(userId: string) {
  const client = useQueryClient();
  const { queryKey } = userSettingsQuery(userId);
  return useMutation({
    mutationFn: (patch: UpdateUserSettingsRequest) => updateUserSettings(patch),
    onSuccess: async (settings) => {
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, settings);
      await client.invalidateQueries({ queryKey });
    },
  });
}

/** Every study read, whichever study: `study` keys are `["study", id]`. */
export const allStudiesKey = ["study"] as const;

/** Refetches everything that shows a run's results or its open checks. */
export function invalidateRun(client: QueryClient, runId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: runQuery(runId).queryKey }),
    client.invalidateQueries({ queryKey: allStudiesKey }),
    client.invalidateQueries({ queryKey: studiesQuery().queryKey }),
  ]);
}

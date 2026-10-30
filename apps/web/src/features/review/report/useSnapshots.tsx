/** Snapshot collection for this run; the viewer supplies pixels, not persistence. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createReviewSnapshot, listReviewSnapshots, reviewFileUrl } from "@voluma/api-client";
import type { ReviewSnapshot } from "@voluma/contracts/snapshot";
import type { SnapshotControls } from "@voluma/viewer";

export function useSnapshots(
  runId: string,
  revisionId: string | undefined,
  taskId: string | undefined,
  onRestore: (snapshot: ReviewSnapshot) => void,
): SnapshotControls | undefined {
  const client = useQueryClient();
  const key = ["review-snapshots", runId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listReviewSnapshots(runId, signal),
    enabled: !!revisionId && !!taskId,
    retry: false,
  });
  if (!revisionId || !taskId) return undefined;
  const items = query.data ?? [];
  return {
    scopeKey: `${revisionId}/${taskId}`,
    save: async (capture) => {
      const saved = await createReviewSnapshot(runId, { ...capture, revisionId, taskId });
      client.setQueryData<ReviewSnapshot[]>(key, (old = []) => [
        ...old.filter((item) => item.id !== saved.id),
        saved,
      ]);
    },
    tray: (
      <details className="border-b border-border px-4 py-2 text-xs" open>
        <summary className="cursor-pointer font-medium">Snapshots ({items.length})</summary>
        {query.isPending && (
          <p role="status" className="mt-2">
            Loading snapshots…
          </p>
        )}
        {query.isError && (
          <p role="alert" className="mt-2">
            Could not load snapshots.{" "}
            <button type="button" className="text-button" onClick={() => void query.refetch()}>
              Retry
            </button>
          </p>
        )}
        {!!items.length && (
          <div className="mt-2 flex max-h-28 flex-wrap gap-3 overflow-y-auto pb-1">
            {items.map((snapshot) => (
              <div key={snapshot.id} className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-2 text-left"
                  onClick={() => onRestore({ ...snapshot })}
                  aria-label={`Reopen snapshot ${snapshot.id}`}
                >
                  <img
                    src={reviewFileUrl(runId, snapshot.png.sha256)}
                    alt=""
                    className="h-12 w-16 border border-border object-contain"
                  />
                  <span>
                    {snapshot.viewState.kind === "acquired"
                      ? `Slice ${snapshot.viewState.sliceIndex + 1}`
                      : "3D"}
                    <br />
                    <span className="text-muted-foreground">
                      {new Date(snapshot.createdAt).toLocaleTimeString()}
                    </span>
                  </span>
                </button>
                <a
                  className="text-button"
                  href={reviewFileUrl(runId, snapshot.png.sha256)}
                  download={`${snapshot.id}.png`}
                >
                  PNG
                </a>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${snapshot.id}.json`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  View state
                </button>
              </div>
            ))}
          </div>
        )}
      </details>
    ),
  };
}

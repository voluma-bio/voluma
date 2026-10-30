/** The run's saved screenshots: saving a captured pane, the tray that lists and reopens them. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createReviewSnapshot, listReviewSnapshots, reviewFileUrl } from "@voluma/api-client";
import type {
  CreateReviewSnapshotRequest,
  GridViewState,
  ReviewSnapshot,
} from "@voluma/contracts/snapshot";
import { useState } from "react";

const planeAxis = { axial: 0, sagittal: 1, coronal: 2 } as const;

function describe({ viewState: v }: ReviewSnapshot) {
  if (v.kind === "acquired") return `Slice ${v.sliceIndex + 1} · earlier viewer`;
  if (v.kind === "3d") return "3D";
  return `${v.plane[0]!.toUpperCase()}${v.plane.slice(1)} ${v.point[planeAxis[v.plane]] + 1}`;
}

export function useSnapshots(
  runId: string,
  revisionId: string | undefined,
  taskId: string | undefined,
  taskName: (id: string) => string,
  onRestore: (snapshot: ReviewSnapshot & { viewState: GridViewState }) => void,
) {
  const client = useQueryClient();
  const key = ["review-snapshots", runId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listReviewSnapshots(runId, signal),
    retry: false,
  });
  // A failed save retries the same id and pixels, never a new capture.
  const [failed, setFailed] = useState<CreateReviewSnapshotRequest>();
  const save = useMutation({
    mutationFn: (request: CreateReviewSnapshotRequest) => createReviewSnapshot(runId, request),
    onMutate: () => setFailed(undefined),
    onSuccess: (saved) =>
      client.setQueryData<ReviewSnapshot[]>(key, (old = []) => [
        ...old.filter((item) => item.id !== saved.id),
        saved,
      ]),
    onError: (_, request) => setFailed(request),
  });
  const items = query.data ?? [];
  const capture =
    revisionId && taskId
      ? (viewState: GridViewState, png: { base64: string }) => {
          if (save.isPending) return;
          save.mutate({
            id: crypto.randomUUID(),
            revisionId,
            taskId,
            viewState,
            pngBase64: png.base64,
          });
        }
      : undefined;
  const tray = (
    <details className="snapshot-tray" open>
      <summary>
        Screenshots ({items.length}){save.isPending && <span role="status"> · Saving…</span>}
      </summary>
      {failed && (
        <p role="alert" className="error-message">
          {save.error instanceof TypeError
            ? "Couldn't save the screenshot. Check your connection."
            : `Couldn't save the screenshot: ${save.error?.message}`}{" "}
          <button type="button" className="text-button" onClick={() => save.mutate(failed)}>
            Retry
          </button>
        </p>
      )}
      {query.isError && (
        <p role="alert">
          Couldn't load screenshots.{" "}
          <button type="button" className="text-button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {items.length > 0 ? (
        <ul>
          {items.map((snapshot) => {
            const { viewState } = snapshot;
            const label = (
              <>
                <img src={reviewFileUrl(runId, snapshot.png.sha256)} alt="" />
                <span>
                  {describe(snapshot)}
                  <br />
                  <span className="text-muted-foreground">
                    {snapshot.taskId === taskId ? "" : `${taskName(snapshot.taskId)} · `}
                    {new Date(snapshot.createdAt).toLocaleTimeString()}
                  </span>
                </span>
              </>
            );
            return (
              <li key={snapshot.id}>
                {viewState.kind === "acquired" ? (
                  <span className="snapshot-item" title="Taken in the earlier viewer">
                    {label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="snapshot-item"
                    aria-label={`Reopen ${describe(snapshot)} screenshot`}
                    onClick={() => onRestore({ ...snapshot, viewState: { ...viewState } })}
                  >
                    {label}
                  </button>
                )}
                <a
                  className="text-button"
                  href={reviewFileUrl(runId, snapshot.png.sha256)}
                  download={`${snapshot.id}.png`}
                >
                  PNG
                </a>
                <a
                  className="text-button"
                  href={`data:application/json,${encodeURIComponent(JSON.stringify(snapshot, null, 2))}`}
                  download={`${snapshot.id}.json`}
                >
                  View state
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        !query.isPending &&
        !query.isError && (
          <p className="text-muted-foreground">
            Use the camera button on a pane to save what it shows.
          </p>
        )
      )}
    </details>
  );
  return { capture, tray };
}

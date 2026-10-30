/** The run's saved screenshots: saving a captured pane, the tray that lists and reopens them. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createReviewSnapshot,
  listReviewSnapshots,
  reviewFileUrl,
} from "@voluma/api-client";
import type {
  CreateReviewSnapshotRequest,
  GridViewState,
  ReviewSnapshot,
} from "@voluma/contracts/snapshot";
import { Button } from "@voluma/ui";
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
  // A save that failed on the network or the server retries the same id and pixels, never a
  // new capture; a refused one (4xx) would only be refused again.
  const [failed, setFailed] = useState<CreateReviewSnapshotRequest>();
  const save = useMutation({
    mutationFn: (request: CreateReviewSnapshotRequest) => createReviewSnapshot(runId, request),
    onMutate: () => setFailed(undefined),
    onSuccess: (saved) =>
      client.setQueryData<ReviewSnapshot[]>(key, (old = []) => [
        ...old.filter((item) => item.id !== saved.id),
        saved,
      ]),
    onError: (error, request) =>
      setFailed(
        !(error instanceof ApiError) || error.status === 0 || error.status >= 500
          ? request
          : undefined,
      ),
  });
  const items = query.data ?? [];
  const capture =
    revisionId && taskId
      ? (viewState: GridViewState, png: { base64: string }) =>
          save.mutate({
            id: crypto.randomUUID(),
            revisionId,
            taskId,
            viewState,
            pngBase64: png.base64,
          })
      : undefined;
  const tray = (
    <details className="snapshot-tray" open>
      <summary>
        Screenshots ({items.length}){save.isPending && <span role="status"> · Saving…</span>}
      </summary>
      {save.isError && (
        <p role="alert" className="error-message">
          {failed
            ? "Couldn't save the screenshot. Check your connection."
            : `Couldn't save the screenshot: ${
                save.error instanceof ApiError
                  ? (save.error.serverMessage ?? save.error.message)
                  : save.error.message
              }`}{" "}
          {failed && (
            <Button variant="link" onClick={() => save.mutate(failed)}>
              Retry
            </Button>
          )}
        </p>
      )}
      {query.isError && (
        <p role="alert">
          Couldn't load screenshots.{" "}
          <Button variant="link" onClick={() => void query.refetch()}>
            Retry
          </Button>
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
                <Button asChild variant="link">
                  <a
                    href={reviewFileUrl(runId, snapshot.png.sha256)}
                    download={`${snapshot.id}.png`}
                  >
                    PNG
                  </a>
                </Button>
                <Button asChild variant="link">
                  <a
                    href={`data:application/json,${encodeURIComponent(JSON.stringify(snapshot, null, 2))}`}
                    download={`${snapshot.id}.json`}
                  >
                    View state
                  </a>
                </Button>
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
  return { capture, tray, saving: save.isPending };
}

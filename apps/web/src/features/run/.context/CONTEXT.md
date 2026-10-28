# Run feature

Three screens under `RunLayout` (top bar and query client): `/` start (`start-page.tsx`),
`/runs` list (`runs-page.tsx`), `/runs/:id/live` live run (`run-page.tsx`).

- **Outputs checklist data** is `workflows/workflow-mouse-oa/outputs.json`, imported as raw text and
  parsed with `outputsFileSchema` (`workflows.ts`). The API never reads workflow files, so there is
  no endpoint for it. The bundle holds the outputs of the commit the web was built from; the runner
  checks selected ids against its own checkout. The API's Railway watch paths include
  `/workflows/*/outputs.json` (see `apps/api/.context/deploy.md`), so an outputs change redeploys the web app.
- **Live tasks** are `fold(events)` over the run's stream (`subscribe`), published at most every
  200 ms. The task list comes from the `revision.started` plan; a task with no attempt yet is Queued.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`keys.tsx`) live in localStorage; the start screen asks for them only for a
  visitor, and a run in `awaiting-keys` shows the same form on its page (`resendKeys`).
- A completed run links to `/runs/:runId`, the review lane's route; the live page is `/runs/:id/live` so it never shadows it. Active runs open live; stopped and failed runs open live too (it shows the error).

Gaps: the list cannot show "N to check" or "Reviewed" (a `Run` carries neither; the review lane
owns the counts), so completed runs read "Completed". Workflow versions are not shown (no versions yet).

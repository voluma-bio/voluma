# Run feature

Three screens under `RunLayout` (top bar and query client): `/` start (`start-page.tsx`),
`/runs` list (`runs-page.tsx`), `/runs/:id/live` live run (`run-page.tsx`).

- **Outputs checklist data** is `workflows/workflow-mouse-oa/outputs.json`, imported as raw text and
  parsed with `outputsFileSchema` (`workflows.ts`). The API never reads workflow files, so there is
  no endpoint for it. The bundle holds the outputs of the commit the web was built from; the runner
  checks selected ids against its own checkout. The API's Railway watch paths include
  `/workflows/*/outputs.json` (set; see `apps/api/.context/deploy.md`), so an outputs change redeploys the web app.
  With every output ticked the request sends no `selectedOutputs` (absent means all), so a default run
  doesn't depend on the bundle matching the runner. Groups are one per producing task.
- **Task titles** are `TASK_TITLES` in `workflows.ts`, a copy of the workflow's task names (neither
  `tasks.json` nor the plan carries a title); don't add another copy. The page reads the plan from the first
  `revision.started` itself because `fold` doesn't expose it.
- **Live tasks** are `fold(events)` over the run's stream (`subscribe`), published at most every
  200 ms. The task list comes from the `revision.started` plan; a task with no attempt yet is Queued.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`keys.tsx`) live in localStorage under `voluma.visitor-keys.<userId>` and are parsed
  with `visitorKeysSchema`; another user of the browser never sees them (a guest has no sign-out, and
  signing in as a member switches id). "Forget keys" on the start screen removes them. The start screen
  asks for keys only for a visitor; a run in `awaiting-keys` shows the form on its page (`resendKeys`) only to the user who started it.
- **Upload scan** (`scan-upload.tsx`, members only) sits under the scan picker. A folder pick drops the
  top folder from each path (it becomes the default name) and skips hidden files; each file is a
  presigned PUT straight to R2 (`putUploadFile`), 4 at once, 3 tries each, then the failed ones are
  listed with Retry. Complete selects the new scan. API side: `apps/api/src/domains/run/.context/uploads.md`.
- A completed run links to `/runs/:runId`, the review lane's route; the live page is `/runs/:id/live` so it never shadows it. Active runs open live; stopped and failed runs open live too (it shows the error).

Gaps: the list cannot show "N to check" or "Reviewed" (a `Run` carries neither; the review lane
owns the counts), so completed runs read "Completed". Workflow versions are not shown (no versions yet).

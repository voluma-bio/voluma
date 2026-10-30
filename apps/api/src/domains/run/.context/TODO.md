# Run domain: deferred work

- **Multipart uploads for files over 5 GB.** A scan upload is one presigned PUT per file
  (`inputs.ts`), so a file is at most `MAX_UPLOAD_FILE_BYTES` (R2's single-PUT limit). No
  scan we have comes near it; a single raw volume over 5 GB would need part URLs and a
  multipart complete, which is a contract change.

- **Cap the studies a caller can create.** `POST /studies` with `start: []` passes no admission check, and a guest costs nothing to mint, so one can write studies (each with up to 200 `study_scans` rows) without limit. Runs stay limited. Cap studies per caller per day in `pg-queue.ts` `createStudy`.

- **Compute `GET /studies` in SQL.** It loads every readable run of the caller's studies (derived results cached) on each Home poll, so the cost grows with the lab's history. Count and pick each scan's newest run in SQL, and derive only those.

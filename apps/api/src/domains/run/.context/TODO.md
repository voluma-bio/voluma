# Run domain: deferred work

- **Drop the retired `runs.to_check` column after the review-state cutover is deployed.**
  No application code reads or writes its value. It remains in the Drizzle schema only
  because Railway applies migrations while the previous server still serves reads.
  Generate a drop migration once those servers have drained; no data backfill is needed.

- **Multipart uploads for files over 5 GB.** A scan upload is one presigned PUT per file
  (`inputs.ts`), so a file is at most `MAX_UPLOAD_FILE_BYTES` (R2's single-PUT limit). No
  scan we have comes near it; a single raw volume over 5 GB would need part URLs and a
  multipart complete, which is a contract change.

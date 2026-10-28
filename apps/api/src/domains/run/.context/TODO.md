# Run domain: deferred work

- **Multipart uploads for files over 5 GB.** A scan upload is one presigned PUT per file
  (`inputs.ts`), so a file is at most `MAX_UPLOAD_FILE_BYTES` (R2's single-PUT limit). No
  scan we have comes near it; a single raw volume over 5 GB would need part URLs and a
  multipart complete, which is a contract change.

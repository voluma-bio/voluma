# Scan uploads

How a member's own scan becomes an input (`inputs.ts`; contract: `@voluma/contracts/run`, Uploads).

- **Two prefixes.** Presigned PUTs write `uploads/<inputId>/`; complete checks every
  declared size there (or already in `inputs/<inputId>/`, so a complete that failed part
  way is finished by the next), copies to `inputs/<inputId>/` and deletes the staged
  copies. No URL can write `inputs/`, so a URL used after complete can't change what a run
  reads. The runner mounts only `inputs/<inputId>/`.
- **Row states.** An upload is an `inputs` row with `status` `uploading` and the declared
  `files`, until complete sets `ready`. `listInputs` and `startRun` see only `ready` rows;
  `startRun` answers the uploader 409 (`input-not-ready`) and everyone else 404 while it
  uploads. Cancel deletes the row only while it is `uploading`, and complete marks it
  ready only if the row survives, so the two can't leave a ready scan with missing files.
- **R2 is optional as a group** (`R2_*` env, shared with Review's reference download):
  without it upload routes answer 503. The API's key must be able to write objects. The
  bucket's CORS allows `PUT` from any origin (rule `scan-upload-put`, set through the
  Cloudflare API): the presigned URL is the credential, so the origin adds nothing.
- **Scripts.** `src/ops/upload-scan.ts` (`pnpm --filter @voluma/api upload:scan`) signs in with
  `POST /api/auth/password` and calls the same routes; it keeps every response's
  `Set-Cookie`, since WorkOS rotates the refresh token.

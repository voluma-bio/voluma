# voluma-sam

The program `segment_sam` runs in the worker's sandbox: it reads a `.npy`, crops it, encodes
the crop (`ffmpeg`), sends it to Meta through the run's gateway, decodes the masks and writes
full-grid labels plus a sidecar. Input is JSON on stdin (`src/input.ts`, also the tool's schema);
stdout is one JSON line. Entry: `src/main.ts`; the steps are `src/run.ts`.

- It is bundled to one file (`pnpm --filter @voluma/sam build`, esbuild) because the sandbox
  image has Node and `ffmpeg` but no workspace. The "Sandbox image" workflow builds it and bakes
  it in as `voluma-sam`; change anything here, run that workflow, update `SANDBOX_IMAGE`.
  The harness and the image are deployed separately, so a schema change reaches the model at once
  but the program only after the digest bump. The program's parse is `.strict()` so a field it
  does not know fails the call; nothing else checks the two agree. Build the image and bump the
  digest in the same PR as any `src/input.ts` change.
- The harness imports only `@voluma/sam/input` (a zod schema and a type). Nothing else is
  shared, and the runner imports none of this package.
- Keep every pass over the reply linear (`src/response.ts`): responses are 100+ MB, and the
  quadratic version of this parse is what stopped staging runs.
- `src/sam-mask.ts` is the one mask decoder. R2 mounts take whole files, so outputs are built in
  `/tmp` and `cp`ed, labels first and the sidecar last.
- Test against the real thing: a saved real Meta response behind a local stub, the real
  OA6-1RK `oriented.npy`, labels compared with an independent decode. No unit fixtures.
- The result's `stream` (first `data:` event, longest gap without a byte, bytes, `data:` lines) is
  measured as the reply is written, per chunk and at constant cost. It exists to check real calls
  against the gateway's host limits (Railway cuts a stream at 15 minutes, or after 5 without a byte).

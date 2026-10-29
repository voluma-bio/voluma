# voluma-sam

The program `segment_sam` runs in the worker's sandbox: it reads a `.npy`, crops it, encodes
the crop (`ffmpeg`), sends it to Meta through the run's gateway, decodes the masks and writes
full-grid labels plus a sidecar. Input is JSON on stdin (`src/input.ts`, also the tool's schema);
stdout is one JSON line. Entry: `src/main.ts`; the steps are `src/run.ts`.

- It is bundled to one file (`pnpm --filter @voluma/sam build`, esbuild) because the sandbox
  image has Node and `ffmpeg` but no workspace. The "Sandbox image" workflow builds it and bakes
  it in as `voluma-sam`; change anything here, run that workflow, update `SANDBOX_IMAGE`.
- The harness imports only `@voluma/sam/input` (a zod schema and a type). Nothing else is
  shared, and the runner imports none of this package.
- Keep every pass over the reply linear (`src/response.ts`): responses are 100+ MB, and the
  quadratic version of this parse is what stopped staging runs.
- `src/sam-mask.ts` is the one mask decoder. R2 mounts take whole files, so outputs are built in
  `/tmp` and `cp`ed, labels first and the sidecar last.
- Test against the real thing: a saved real Meta response behind a local stub, the real
  OA6-1RK `oriented.npy`, labels compared with an independent decode. No unit fixtures.

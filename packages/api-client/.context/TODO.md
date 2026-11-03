# API client TODO

- **Writes have no timeout.** `request` sets no `AbortSignal`, so a write that never answers
  (`placeMark`, `sendRunMessage`, `answerApproval`) leaves its caller waiting until a reload: the
  outputs review's Send stays at "Sending…" behind a stalled mark write (`settled`, `run-marks.ts`).
  Give every call an `AbortSignal.timeout`, in `request`, not per caller.

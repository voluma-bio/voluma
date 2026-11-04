# Throwaway: replay a staging run as a sped-up live local run

Hackathon timelapse for staging run `ac073c0c-12b0-43e7-82f0-fe0e613116e5`.
Do not merge. Branch: `jimyao/p1739-timelapse`.

The local run gets a new id. Review assets and published files are **read**
from the staging run's R2 prefix (no copy, no write). A fake far-future lease
stops a runner claiming it.

```bash
# 1. Collect the staging SSE (work dir collect-stream.py), then freeze it.
# 2. pnpm dev in this worktree
# 3. Guest-sign-in, then:
pnpm --filter @voluma/api replay:run -- --setup --user <me.userId> --lab <me.labId>
pnpm --filter @voluma/api replay:run -- --play --from events.jsonl --target-seconds 100
# 4. Open /studies/<studyId>/inputs/<inputId>
```

`apps/api/src/replay-map.ts` remaps R2 reads. Stream poll is 100 ms so the
page keeps up.

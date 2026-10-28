# Run feature: deferred work

- **Token streaming in the thread view.** The stream carries durable events only, so a message or tool call appears whole when it ends. Needs the live frames in `packages/contracts/src/stream.ts` to be served.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the run page.
- **Cost.** No cost is on the page yet; per-call usage is on the message and wake events (`modelUsageSchema`).

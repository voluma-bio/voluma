# Run feature: deferred work

- **Move `chat/` to `packages/ui`** when the review chat wants the same transcript pieces.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the run page.

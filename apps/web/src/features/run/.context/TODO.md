# Run feature: deferred work

- **See token streaming live.** The page folds live frames, but the runner and API serve none until `jimyao/live-frames` merges; check the caret, partial tool rows and the main thread's streaming note on a real run then.
- **Move `chat/` to `packages/ui`** when the review chat wants the same transcript pieces.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the run page.

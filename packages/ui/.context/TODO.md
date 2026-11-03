# packages/ui: deferred work

- `side-panel.tsx` reads its widths from localStorage at import time into a module variable
  that every story and test shares. Move them into `AppShell`'s state, beside fold state, so
  shell state has one owner (structure review of #452, p1275).

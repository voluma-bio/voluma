# packages/ui: deferred work

- One panel system (structure review of #452, p1275). The scan page
  (`features/input/input-page.tsx`) still docks `ShellPanel`s while the study pages use
  `SidePanel`, and the two keep separate state: widths in `voluma.shell` (left 280–720 px) and
  `voluma.sides` (220–520 px), so a width set on a study page doesn't carry into a scan, and only
  `ShellPanel` takes part in the `MAIN_MIN` squeeze; they share only fold state and the `\`, `]`
  and F keys. Move the scan page to `SidePanel`, then delete `ShellPanel`, `useOpenPanel`, the
  docked strips and the registration machinery in `shell/shell.tsx`, so `AppShell` is the
  header, rail, main area and fold state.
- `side-panel.tsx` reads its widths from localStorage at import time into a module variable
  that every story and test shares. Move them into `AppShell`'s state, beside fold state, so
  shell state has one owner (same review).

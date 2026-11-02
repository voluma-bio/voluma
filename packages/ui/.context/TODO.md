# packages/ui: deferred work

- Delete `ShellPanel`, `ShellLink`, `useOpenPanel` and the docked strips in `shell/shell.tsx`
  once the task review (`features/scan/scan-page.tsx`) and the study's section pages have moved
  to `SidePanel` or gone with the task loop. Until then `AppShell` carries both: the rail and
  fold state for every screen, the strips only where a screen still registers panels.

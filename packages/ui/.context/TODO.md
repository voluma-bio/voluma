# packages/ui: deferred work

- Delete `ShellPanel`, `ShellLink`, `useOpenPanel` and the docked strips in `shell/shell.tsx`
  once the task review (`features/scan/scan-page.tsx`, with its study dock) has moved to
  `SidePanel` or gone with the task loop; the study pages no longer use them, and `ShellLink` has
  no caller. Until then `AppShell` carries both: the rail and
  fold state for every screen, the strips only where a screen still registers panels.

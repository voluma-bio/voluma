/** Small pieces the study feature's pages share: loading and load-error lines. */
import { Button } from "@voluma/ui";
import type { ReactNode } from "react";

/** Shown only when loading is slow, so a fast load doesn't flash it. */
export function Delayed({ children }: { children: ReactNode }) {
  return (
    <p
      aria-busy="true"
      className="animate-[appear_200ms_ease-out_600ms_both] text-ui text-muted-foreground"
    >
      {children}
    </p>
  );
}

export function LoadError({ what, retry }: { what: string; retry: () => void }) {
  return (
    <p role="alert" className="text-destructive">
      Couldn't load {what}.{" "}
      <Button variant="link" onClick={retry}>
        Try again
      </Button>
    </p>
  );
}
